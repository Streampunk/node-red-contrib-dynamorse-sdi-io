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

var redioactive = require('node-red-contrib-dynamorse-core').Redioactive;
var util = require('util');
var Promise = require('promise');
var macadam;
try { macadam = require('macadam'); } catch(err) { console.log('SDI-Out: ' + err); }
var Grain = require('node-red-contrib-dynamorse-core').Grain;

const BMDOutputFrameCompleted = 0;
const BMDOutputFrameDisplayedLate = 1;
const BMDOutputFrameDropped = 2;
const BMDOutputFrameFlushed = 3;


module.exports = function (RED) {
  function SDIOut (config) {
    RED.nodes.createNode(this, config);
    redioactive.Spout.call(this, config);

    this.srcFlow = null;
    var sentCount = 0;
    var playedCount = 0;
    var playback = null;
    var node = this;
    var begin = null;
    var playState = BMDOutputFrameCompleted;
    var producingEnough = true;

    this.each((x, next) => {
      if (!Grain.isGrain(x)) {
        node.warn('Received non-Grain payload.');
        return next();
      }
      var nextJob = (node.srcFlow) ?
        Promise.resolve(x) :
        (Promise.denodeify(node.getNMOSFlow, 1))(x)
        .then(f => {
          node.srcFlow = f;
          if (f.tags.format[0] !== 'video') {
            return node.preFlightError('Only video sources supported for SDI out.');
          }
          // Set defaults to the most commonly format for dynamorse testing
          // TODO: support for DCI modes
          var bmMode = macadam.bmdModeHD1080i50;
          var bmFormat = macadam.bmdFormat10BitYUV;
          switch (+f.tags.height[0]) {
            case 2160:
              switch (x.getDuration()[1]) {
                case 25:
                case 25000:
                  bmMode = macadam.bmdMode4K2160p25;
                  break;
                case 24:
                case 24000:
                  bmdMode = (x.getDuration()[0] === 1001) ?
                    macadam.bmdMode4K2160p2398 : macadam.bmdMode4K2160p24;
                  break;
                case 30:
                case 30000:
                  bmdMode = (x.getDuration()[0] === 1001) ?
                    macadam.bmdMode4K2160p2997 : macadam.bmdMode4K2160p30;
                  break;
                case 50:
                case 50000:
                  bmdMode = macadam.bmdMode4K2160p50;
                  break;
                case 60:
                case 60000:
                  bmdMode = (x.getDuration()[0] === 1001) ?
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
                  bmMode = (f.tags.interlace[0] === '1') ?
                    macadam.bmdModeHD1080i50 : macadam.bmdModeHD1080p25;
                    break;
                case 24:
                case 24000:
                  if (x.getDuration()[0] === 1001) {
                    bmdMode = (f.tags.interlace[0] === '1') ?
                      macadam.bmdModeHD1080i5994 : macadam.bmdModeHD1080p2398;
                  } else {
                    bmdMode = macadam.bmdModeHD1080p24;
                  }
                  break;
                case 30:
                case 30000:
                  if (x.getDuration()[0] === 1001) {
                    bmdMode = (f.tags.interlace[0] === '1') ?
                      macadam.bmdModeHD1080i5994 : macadam.bmdModeHD1080p2997;
                  } else {
                    bmdMode = (f.tags.interlace[0] === '1') ?
                      macadam.bmdModeHD1080i6000 : macadam.bmdModeHD1080p30;
                  }
                  break;
                case 50:
                case 50000:
                  bmdMode = macadam.bmdModeHD1080p50;
                  break;
                case 60:
                case 60000:
                  bmdMode = (x.getDuration()[0] === 1001) ?
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
                  bmdMode = macadam.bmdModeHD720p50;
                  break;
                case 60:
                case 60000:
                  bmdMode = (x.getDuration()[0] === '1') ?
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
                  bmdMode = bmdModePAL;
                  break;
                case 50:
                case 50000:
                  bmdMode = bmcModePALp;
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
                  bmdMode = bmdModeNTSC;
                  break;
                case 60:
                case 60000:
                  bmdMode = bmdModeNTSCp;
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
          if (f.tags.packing && f.tags.packing.length >= 1)
            bmFormat = macadam.fourCCFormat(f.tags.packing[0]);
          playback = new macadam.Playback(config.deviceIndex,
            bmMode, bmFormat);
          playback.on('error', e => {
            node.warn(`Received playback error from Blackmagic card: ${e}`);
            next();
          });

          begin = process.hrtime();
          return x;
        });
      nextJob.then(g => {
        playback.frame(g.buffers[0]);
        sentCount++;
        if (sentCount === +config.frameCache) {
          this.log('Starting playback.');
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
                case bmdOutputFrameFlushed:
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
        setTimeout(next, (diff > 0) ? diff : 0);
        // if (sentCount < +config.frameCache) {
        //   node.log(`Caching frame ${sentCount}/${typeof config.frameCache}.`);
        //   playback.frame(g.buffers[0]);
        //   sentCount++;
        //   if (sentCount === +config.frameCache) {
        //     node.log('Starting playback.');
        //     playback.start();
        //     playback.on('played', p => {
        //       playedCount++;
        //       next(); next();
        //       if (p > 0) { console.error('XXX'); next(); }
        //     });
        //   }
        //   next();
        // } else {
        //   // console.log(`next frame ${sentCount}.`);
        //   playback.frame(g.buffers[0]);
        //   sentCount++;
        // };
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
    });
    node.close(() => {
      node.log('Closing the video - too bright!');
      playback.stop();
    });
    process.on('exit', () => {
      if (playback) playback.stop();
    });
    process.on('SIGINT', () => {
      if (playback) playback.stop();
    });
  }
  util.inherits(SDIOut, redioactive.Spout);
  RED.nodes.registerType("sdi-out", SDIOut);
}
