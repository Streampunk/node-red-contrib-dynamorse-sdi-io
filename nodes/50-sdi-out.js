/* Copyright 2017 Streampunk Media Ltd.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by appl cable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

const redioactive = require('node-red-contrib-dynamorse-core').Redioactive;
const util = require('util');
var macadam;
try { macadam = require('macadam'); } catch(err) { console.log('SDI-Out: ' + err); }
const Grain = require('node-red-contrib-dynamorse-core').Grain;
const uuid = require('uuid');

const BMDOutputFrameCompleted = 0;
const BMDOutputFrameDisplayedLate = 1;
const BMDOutputFrameDropped = 2;
const BMDOutputFrameFlushed = 3;

function extractVersions (v) {
  var m = v.match(/^([0-9]+):([0-9]+)$/);
  if (m === null) { return [Number.MAX_SAFE_INTEGER, 0]; }
  return [+m[1], +m[2]];
}

function compareVersions (l, r) {
  var lm = extractVersions(l);
  var rm = extractVersions(r);
  if (lm[0] < rm[0]) return -1;
  if (lm[0] > rm[0]) return 1;
  if (lm[1] < rm[1]) return -1;
  if (lm[1] > rm[1]) return 1;
  return 0;
}

module.exports = function (RED) {
  function SDIOut (config) {
    RED.nodes.createNode(this, config);
    redioactive.Spout.call(this, config);

    this.srcVideoFlow = null;
    var sentCount = 0;
    var playedCount = 0;
    var playback = null;
    var node = this;
    var begin = null;
    var playState = BMDOutputFrameCompleted;
    var producingEnough = true;
    var videoSrcFlowID = null;
    var audioSrcFlowID = null;
    var audioTags = null;
    var grainCache = {};

    function tryGetCachedGrain (grain, type) { // TODO change to fuzzy match
      let timestamp = grain.formatTimestamp(grain.ptpOrigin);
      let cachedGrain = grainCache[timestamp];
      if (cachedGrain) {
        if (cachedGrain.type !== type) { // TODO consider other grain types
          delete grainCache[timestamp];
          return cachedGrain.grain;
        } else {
          node.warn(`For timestamp ${timestamp}, received two grains of the same type ${type}.`);
        }
      } else {
        grainCache[timestamp] = { grain: grain, type: type };
        return null;
      }
    }

    var clearDown = setInterval(() => {
      let grainKeys = Object.keys(grainCache);
      node.log(`Clearing down grain cache of size ${grainKeys.length}.`);
      let ditch = grainKeys.sort(compareVersions).slice(0, -10);
      ditch.forEach(x => {
        node.warn(`For timestamp ${x}, grain of type ${grainCache[x].type} was not matched. Discarding.`);
        delete grainCache[x];
      });
    }, 5000);

    this.each((x, next) => {
      if (!Grain.isGrain(x)) {
        node.warn('Received non-Grain payload.');
        return next();
      }
      var nextJob = (node.srcVideoFlow) ?
        Promise.resolve(x) :
        this.findCable(x)
          .then(c => {
            var fv = (Array.isArray(c[0].video) && c[0].video.find(
              z => z.tags.encodingName === 'raw' && z.tags.packing === 'v210'));
            if (!fv) {
              return Promise.reject('Cable must contain at least one video flow.');
            }
            node.srcVideoFlow = fv;
            videoSrcFlowID = fv.flowID;

            var fa = (Array.isArray(c[0].audio) && c[0].audio.length > 0) ? c[0].audio[0] : null;
            if (fa) {
              if (fa.tags.clockRate !== 48000) {
                return Promise.reject('Blackmagic hardware only supports 48kHz audio streams.');
              }
              node.log('We have audio: ' + JSON.stringify(c[0].audio));
              audioSrcFlowID = fa.flowID;
              audioTags = fa.tags;
              audioTags.bitsPerSample = +fa.tags.encodingName.substring(1);
            }
            // Set defaults to the most commonly format for dynamorse testing
            // TODO: support for DCI modes
            var bmMode = macadam.bmdModeHD1080i50;
            var bmFormat = macadam.bmdFormat10BitYUV;
            switch (fv.tags.height) {
            case 2160:
              switch (x.getDuration()[1]) {
              case 25:
              case 25000:
                bmMode = macadam.bmdMode4K2160p25;
                break;
              case 24:
              case 24000:
                bmMode = (x.getDuration()[0] === 1001) ?
                  macadam.bmdMode4K2160p2398 : macadam.bmdMode4K2160p24;
                break;
              case 30:
              case 30000:
                bmMode = (x.getDuration()[0] === 1001) ?
                  macadam.bmdMode4K2160p2997 : macadam.bmdMode4K2160p30;
                break;
              case 50:
              case 50000:
                bmMode = macadam.bmdMode4K2160p50;
                break;
              case 60:
              case 60000:
                bmMode = (x.getDuration()[0] === 1001) ?
                  macadam.bmdMode4K2160p5994 : macadam.bmdMode4k2160p60;
                break;
              default:
                node.preFlightError('Could not establish Blackmagic mode.');
                break;
              }
              break;
            case 1080:
              switch (x.getDuration()[1]) {
              case 25:
              case 25000:
                bmMode = (fv.tags.interlace === true) ?
                  macadam.bmdModeHD1080i50 : macadam.bmdModeHD1080p25;
                break;
              case 24:
              case 24000:
                if (x.getDuration()[0] === 1001) {
                  bmMode = (fv.tags.interlace === true) ?
                    macadam.bmdModeHD1080i5994 : macadam.bmdModeHD1080p2398;
                } else {
                  bmMode = macadam.bmdModeHD1080p24;
                }
                break;
              case 30:
              case 30000:
                if (x.getDuration()[0] === 1001) {
                  bmMode = (fv.tags.interlace === true) ?
                    macadam.bmdModeHD1080i5994 : macadam.bmdModeHD1080p2997;
                } else {
                  bmMode = (fv.tags.interlace === true) ?
                    macadam.bmdModeHD1080i6000 : macadam.bmdModeHD1080p30;
                }
                break;
              case 50:
              case 50000:
                bmMode = macadam.bmdModeHD1080p50;
                break;
              case 60:
              case 60000:
                bmMode = (x.getDuration()[0] === 1001) ?
                  macadam.bmdModeHD1080p5994 : macadam.bmdModeHD1080p6000;
                break;
              default:
                node.preFlightError('Could not establish Blackmagic mode.');
                break;
              }
              break;
            case 720:
              switch (x.getDuration()[1]) {
              case 50:
              case 50000:
                bmMode = macadam.bmdModeHD720p50;
                break;
              case 60:
              case 60000:
                bmMode = (x.getDuration()[0] === '1') ?
                  macadam.bmdModeHD720p5994 : macadam.bmdModeHD720p60;
                break;
              default:
                node.preFlightError('Could not establish Blackmagic mode.');
                break;
              }
              break;
            case 576:
              switch (x.getDuration()[1]) {
              case 25:
              case 25000:
                bmMode = macadam.bmdModePAL;
                break;
              case 50:
              case 50000:
                bmMode = macadam.bmcModePALp;
                break;
              default:
                node.preFlightError('Could not establish Blackmagic mode.');
                break;
              }
              break;
            case 486:
              switch (x.getDuration()[1]) {
              case 30:
              case 30000:
                bmMode = macadam.bmdModeNTSC;
                break;
              case 60:
              case 60000:
                bmMode = macadam.bmdModeNTSCp;
                break;
              default:
                node.preFlightError('Could not establish Blackmagic mode.');
                break;
              }
              break;
            default:
              node.preFlightError('Could not establish Blackmagic mode.');
              break;
            }
            if (fv.tags.packing)
              bmFormat = macadam.fourCCFormat(fv.tags.packing);
            playback = new macadam.Playback(config.deviceIndex,
              bmMode, bmFormat);
            if (fa) {
              playback.enableAudio(macadam.bmdAudioSampleRate48kHz,
                macadam.bmdAudioSampleType16bitInteger, 2);
            }
            playback.on('error', e => {
              node.warn(`Received playback error from Blackmagic card: ${e}`);
              next();
            });

            begin = process.hrtime();
            return x;
          });
      nextJob.then(g => {
        var flowID = uuid.unparse(g.flow_id);
        var audioGrain = null;
        var videoGrain = null;

        if (flowID === videoSrcFlowID) {
          if (audioSrcFlowID === null) {
            videoGrain = g;
          } else {
            audioGrain = tryGetCachedGrain(g, 'video');
            if (audioGrain) {
              videoGrain = g;
            }
          }
        } else if (flowID === audioSrcFlowID) {
          videoGrain = tryGetCachedGrain(g, 'audio');
          if (videoGrain) {
            audioGrain = g;
          }
        } else {
          return next();
        }

        if (videoGrain) {
          if (audioGrain) {
            playback.frame(videoGrain.buffers[0],
              audioMunge(audioTags, audioGrain.buffers[0]));
          } else {
            playback.frame(videoGrain.buffers[0]);
          }
          sentCount++;
          if (sentCount === +config.frameCache) {
            node.log('Starting playback.');
            playback.start();
            playback.on('played', p => {
              playedCount++;
              if (p !== playState) {
                playState = p;
                switch (playState) {
                case BMDOutputFrameCompleted:
                  this.warn(`After ${playedCount} frames, playback state returned to frame completed OK.`);
                  break;
                case BMDOutputFrameDisplayedLate:
                  this.warn(`After ${playedCount} frames, playback state is now displaying frames late.`);
                  break;
                case BMDOutputFrameDropped:
                  this.warn(`After ${playedCount} frames, playback state is dropping frames.`);
                  break;
                case BMDOutputFrameFlushed:
                  this.warn(`After ${playedCount} frames, playback state is flushing frames.`);
                  break;
                default:
                  this.error(`After ${playedCount} frames, playback state is unknown, code ${playState}.`);
                  break;
                }
              }
            });
          }
          var diffTime = process.hrtime(begin);
          var diff = (sentCount * config.timeout) -
            (diffTime[0] * 1000 + diffTime[1] / 1000000|0);
          if ((diff < 0) && (producingEnough === true)) {
            this.warn(`After sending ${sentCount} frames and playing ${playedCount}, not producing frames fast enough for SDI output.`);
            producingEnough = false;
          }
          if ((diff > 0) && (producingEnough === false)) {
            this.warn(`After sending ${sentCount} frames and playing ${playedCount}, started producing enough frames fast enough for SDI output.`);
            producingEnough = true;
          }
          // console.log('Calling next in', diff);
          setTimeout(next, (diff > 0) ? diff : 0);
        } else {
          setImmediate(next);
        }
      })
        .catch(err => {
          node.error(`Failed to play video on device '${config.deviceIndex}': ${err}`);
        });
    });

    node.errors((e, next) => {
      node.warn(`Received unhandled error: ${e.message}.`);
      setImmediate(next);
    });
    node.done(() => {
      node.log('No more to see here!');
      playback.stop();
      clearInterval(clearDown);
    });
    node.on('close', () => {
      node.log('Closing the video - too bright!');
      playback.stop();
      clearInterval(clearDown);
      this.close();
    });
    process.on('exit', () => {
      if (playback) playback.stop();
      clearInterval(clearDown);
    });
    process.on('SIGINT', () => {
      if (playback) playback.stop();
      clearInterval(clearDown);
      process.exit();
    });
  }
  util.inherits(SDIOut, redioactive.Spout);
  RED.nodes.registerType('sdi-out', SDIOut);
};

function audioMunge(tags, samples) {
  // console.log(samples.length, samples);
  var result = null;
  switch (tags.bitsPerSample) {
  case 16:
    result = Buffer.allocUnsafe(samples.length);
    for ( let x = 0 ; x < samples.length ; x += 2) {
      result[x + 1] = samples[x];
      result[x] = samples[x + 1];
    }
    break;
  case 24:
    result = Buffer.allocUnsafe(samples.length * 2 / 3|0);
    var y = 0;
    for ( let x = 0 ; x < samples.length ; x += 3) {
      result[y++] = samples[x + 1];
      result[y++] = samples[x + 0];
    }
    break;
  default:
    result = samples;
  }
  if (tags.channels == 1) {
    var twoResult = Buffer.allocUnsafe(result.length * 2);
    for ( let x = 0 ; x < result.length ; x += 2 ) {
      twoResult[x * 2] = result[x];
      twoResult[x * 2 + 1] = result[x + 1];
      twoResult[x * 2 + 2] = result[x];
      twoResult[x * 2 + 3] = result[x + 1];
    }
    result = twoResult;
  }
  // console.log(result.length, result);
  return result;
}
