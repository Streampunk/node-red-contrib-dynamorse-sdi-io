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

var redioactive = require('node-red-contrib-dynamorse-core').Redioactive;
var util = require('util');
var macadam;
try { macadam = require('macadam'); } catch(err) { console.log('SDI-In: ' + err); }
var Grain = require('node-red-contrib-dynamorse-core').Grain;

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
    var node = this;
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
    this.baseTime = [ Date.now() / 1000|0, (Date.now() % 1000) * 1000000 ];
    this.makeCable({ video: [ { tags: this.vtags } ], backPressure: "video[0]" });

    var flowID = this.flowID();
    var sourceID = this.sourceID();

    node.log(`You wanted audio? ${config.audio}`);

    this.eventMuncher(capture, 'frame', payload => {
      var grainTime = Buffer.allocUnsafe(10);
      grainTime.writeUIntBE(this.baseTime[0], 0, 6);
      grainTime.writeUInt32BE(this.baseTime[1], 6);
      this.baseTime[1] = ( this.baseTime[1] +
        grainDuration[0] * 1000000000 / grainDuration[1]|0 );
      this.baseTime = [ this.baseTime[0] + this.baseTime[1] / 1000000000|0,
        this.baseTime[1] % 1000000000];
      return new Grain([payload], grainTime, grainTime, null,
        flowID, sourceID, grainDuration); // TODO Timecode support
    });

    capture.on('error', e => {
      this.push(e);
    });

    this.on('close', () => {
      this.close();
      capture.stop();
    });
  }
  util.inherits(SDIIn, redioactive.Funnel);
  RED.nodes.registerType("sdi-in", SDIIn);
}
