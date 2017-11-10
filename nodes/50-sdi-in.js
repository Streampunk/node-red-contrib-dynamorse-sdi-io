/* Copyright 2017 Streampunk Media Ltd.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

const redioactive = require('node-red-contrib-dynamorse-core').Redioactive;
const util = require('util');
var macadam;
try { macadam = require('macadam'); } catch(err) { console.log('SDI-In: ' + err); }
const Grain = require('node-red-contrib-dynamorse-core').Grain;

function fixBMDCodes(code) {
  if (code === 'ARGB') return 32;
  return macadam.bmCodeToInt(code);
}

module.exports = function (RED) {
  function SDIIn (config) {
    RED.nodes.createNode(this,config);
    redioactive.Funnel.call(this, config);

    // Do we need this
    if (!this.context().global.get('updated'))
      return this.log('Waiting for global context updated.');

    var capture = new macadam.Capture(config.deviceIndex,
      fixBMDCodes(config.mode), fixBMDCodes(config.format));
    if (config.audio == true)
      capture.enableAudio(macadam.bmdAudioSampleRate48kHz, macadam.bmdAudioSampleType16bitInteger, 2);

    var grainDuration = macadam.modeGrainDuration(fixBMDCodes(config.mode));
    this.vtags = {
      format : 'video',
      encodingName : 'raw',
      width : macadam.modeWidth(fixBMDCodes(config.mode)),
      height : macadam.modeHeight(fixBMDCodes(config.mode)),
      depth : macadam.formatDepth(fixBMDCodes(config.format)),
      packing : macadam.formatFourCC(fixBMDCodes(config.format)),
      sampling : macadam.formatSampling(fixBMDCodes(config.format)),
      clockRate : 90000,
      interlace : macadam.modeInterlace(fixBMDCodes(config.mode)),
      colorimetry : macadam.formatColorimetry(fixBMDCodes(config.format)),
      grainDuration : grainDuration
    };
    this.atags = {
      format: 'audio',
      encodingName: 'L16',
      clockRate: 48000,
      channels: 2,
      blockAlign: 4,
      grainDuration: grainDuration
    };
    this.baseTime = [ Date.now() / 1000|0, (Date.now() % 1000) * 1000000 ];
    var cable = { video: [ { tags: this.vtags } ], backPressure: 'video[0]' };
    if (config.audio === true)
      cable.audio = [ { tags: this.atags } ];
    this.makeCable(cable);

    var ids = {
      vFlowID: this.flowID('video[0]'),
      vSourceID: this.sourceID('video[0]'),
      aFlowID: (config.audio === true) ? this.flowID('audio[0]') : undefined,
      aSourceID: (config.audio === true) ? this.sourceID('audio[0]') : undefined
    };

    console.log('You wanted audio?', ids);

    this.eventMuncher(capture, 'frame', (video, audio) => {
      console.log('Event muching', video.length, audio);
      var grainTime = Buffer.allocUnsafe(10);
      grainTime.writeUIntBE(this.baseTime[0], 0, 6);
      grainTime.writeUInt32BE(this.baseTime[1], 6);
      this.baseTime[1] = ( this.baseTime[1] +
        grainDuration[0] * 1000000000 / grainDuration[1]|0 );
      this.baseTime = [ this.baseTime[0] + this.baseTime[1] / 1000000000|0,
        this.baseTime[1] % 1000000000];
      var va = [ new Grain([video], grainTime, grainTime, null,
        ids.vFlowID, ids.vSourceID, grainDuration) ]; // TODO Timecode support
      if (config.audio === true && audio) va.push(
        new Grain([audio], grainTime, grainTime, null,
          ids.aFlowID, ids.aSourceID, grainDuration));
      return va;
    });

    capture.on('error', e => {
      this.push(e);
    });

    this.on('close', () => {
      this.close();
      capture.stop();
    });

    capture.start();
  }
  util.inherits(SDIIn, redioactive.Funnel);
  RED.nodes.registerType('sdi-in', SDIIn);
};
