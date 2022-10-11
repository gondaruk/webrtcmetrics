import Exporter from "./exporter";
import { extract } from "./extractor";
import {
  computeMOS,
  computeEModelMOS,
  computeMOSForOutgoing,
  computeEModelMOSForOutgoing,
} from "./utils/score";
import {
  COLLECTOR_STATE, DIRECTION,
  defaultAudioMetricIn,
  defaultAudioMetricOut,
  defaultVideoMetricIn,
  defaultVideoMetricOut,
  getDefaultMetric,
  VALUE,
  TYPE,
} from "./utils/models";
import { createCollectorId, call } from "./utils/helper";
import { debug, error, info } from "./utils/log";

export default class Collector {
  constructor(cfg, refProbeId) {
    this._callbacks = {
      onreport: null,
      onticket: null,
    };

    this._id = createCollectorId();
    this._moduleName = this._id;
    this._probeId = refProbeId;
    this._config = cfg;
    this._exporter = new Exporter(cfg);
    this._state = COLLECTOR_STATE.IDLE;
    this.registerToPCEvents();
    info(this._moduleName, `new collector created for probe ${this._probeId}`);
  }

  analyze(stats, previousReport, beforeLastReport, referenceReport) {
    const getDefaultSSRCMetric = (kind, reportType) => {
      if (kind === VALUE.AUDIO) {
        if (reportType === TYPE.INBOUND_RTP) {
          return { ...defaultAudioMetricIn };
        }
        return { ...defaultAudioMetricOut };
      }

      if (reportType === TYPE.INBOUND_RTP) {
        return { ...defaultVideoMetricIn };
      }
      return { ...defaultVideoMetricOut };
    };

    // Get previous report without any modifications
    const report = getDefaultMetric(previousReport);

    let timestamp = null;
    stats.forEach((stat) => {
      if (!timestamp && stat.timestamp) {
        timestamp = stat.timestamp;
      }
      const values = extract(stat, report, report.pname, referenceReport, stats);
      values.forEach((data) => {
        if ("internal" in data) {
          this.doInternalTreatment(data, previousReport);
        }
        if (data.value && data.type) {
          if (data.ssrc) {
            let ssrcReport = report[data.type][data.ssrc];
            if (!ssrcReport) {
              ssrcReport = getDefaultSSRCMetric(data.type, stat.type);
              ssrcReport.ssrc = data.ssrc;
              report[data.type][data.ssrc] = (ssrcReport);
            }
            Object.keys(data.value).forEach((key) => {
              ssrcReport[key] = data.value[key];
            });
          } else {
            Object.keys(data.value).forEach((key) => {
              report[data.type][key] = data.value[key];
            });
          }
        }
      });
    });
    report.pname = this._config.pname;
    report.call_id = this._config.cid;
    report.user_id = this._config.uid;
    report.count = previousReport ? previousReport.count + 1 : 1;
    report.timestamp = timestamp;
    Object.keys(report[VALUE.AUDIO]).forEach((key) => {
      const ssrcReport = report[VALUE.AUDIO][key];
      if (ssrcReport.direction === DIRECTION.INBOUND) {
        ssrcReport.mos_emodel_in = computeEModelMOS(
          report,
          VALUE.AUDIO,
          previousReport,
          beforeLastReport,
          ssrcReport.ssrc,
        );
        ssrcReport.mos_in = computeMOS(
          report,
          VALUE.AUDIO,
          previousReport,
          beforeLastReport,
          ssrcReport.ssrc,
        );
      } else {
        ssrcReport.mos_emodel_out = computeEModelMOSForOutgoing(
          report,
          VALUE.AUDIO,
          previousReport,
          beforeLastReport,
          ssrcReport.ssrc,
        );
        ssrcReport.mos_out = computeMOSForOutgoing(
          report,
          VALUE.AUDIO,
          previousReport,
          beforeLastReport,
          ssrcReport.ssrc,
        );
      }
    });
    return report;
  }

  doInternalTreatment(data, previousReport) {
    const compareAndSendEventForDevice = (property) => {
      const previousTrackId = (data.type in previousReport && data.ssrc in previousReport[data.type] && previousReport[data.type][data.ssrc][property]) || null;
      if (previousTrackId && previousTrackId !== data.value.track_out) {
        this.addCustomEvent(
          new Date().toJSON(),
          "device",
          "change",
          "The outbound device (microphone/camera) has changed",
          { ssrc: data.ssrc, type: data.type },
        );
      }
    };
    const compareAndSendEventForSize = (property) => {
      const size = data.value[property];
      const previousSize = (data.type in previousReport && data.ssrc in previousReport[data.type] && previousReport[data.type][data.ssrc][property]) || null;
      if (previousSize.width !== size.width && previousSize !== undefined) {
        this.addCustomEvent(
          new Date().toJSON(),
          "device",
          "resolution",
          `The resolution of the inbound device has ${previousSize.width > size.width ? "decreased" : "increased"}`,
          {
            ssrc: data.ssrc,
            size: `${size.width}x${size.height}`,
            size_old: `${previousSize.width}x${previousSize.height}`,
          },
        );
      }
      if (previousSize.framerate !== undefined && Math.abs(previousSize.framerate - size.framerate) > 2) {
        this.addCustomEvent(
          new Date().toJSON(),
          "device",
          "framerate",
          `The framerate of the inbound device has ${previousSize.framerate > size.framerate ? "decreased" : "increased"}`,
          {
            ssrc: data.ssrc,
            framerate: size.framerate,
            framerate_old: previousSize.framerate,
          },
        );
      }
    };

    if (previousReport) {
      switch (data.internal) {
        case "deviceChanged": {
          compareAndSendEventForDevice("track_out");
          break;
        }
        case "inputSizeChanged": {
          compareAndSendEventForSize("size_in");
          break;
        }
        case "outputSizeChanged": {
          compareAndSendEventForSize("size_out");
          break;
        }
        default:
          break;
      }
    }
  }

  async takeReferenceStats() {
    return new Promise((resolve, reject) => {
      const preWaitTime = Date.now();
      setTimeout(async () => {
        try {
          const waitTime = Date.now() - preWaitTime;
          const preTime = Date.now();
          const reports = await this._config.pc.getStats();
          const referenceReport = this.analyze(reports, null, null, null);
          const postTime = Date.now();
          referenceReport.experimental.time_to_measure_ms = postTime - preTime;
          referenceReport.experimental.time_to_wait_ms = waitTime;
          this._exporter.saveReferenceReport(referenceReport);
          debug(
            this._moduleName,
            `got reference report for probe ${this._probeId}`,
          );
          resolve();
        } catch (err) {
          reject(err);
        }
      }, this._config.startAfter);
    });
  }

  async collectStats() {
    try {
      if (this._state !== COLLECTOR_STATE.RUNNING || !this._config.pc) {
        debug(
          this._moduleName,
          `report discarded (too late) for probe ${this._probeId}`,
        );
        return null;
      }

      // Take into account last report in case no report have been generated (eg: candidate-pair)
      const preTime = Date.now();
      const reports = await this._config.pc.getStats();
      const report = this.analyze(
        reports,
        this._exporter.getLastReport(),
        this._exporter.getBeforeLastReport(),
        this._exporter.getReferenceReport(),
      );
      const postTime = Date.now();
      report.experimental.time_to_measure_ms = postTime - preTime;
      this._exporter.addReport(report);
      debug(
        this._moduleName,
        `got report for probe ${this._probeId}#${
          this._exporter.getReportsNumber() + 1
        }`,
      );
      this.fireOnReport(report);
      return report;
    } catch (err) {
      error(this._moduleName, `got error ${err}`);
      return null;
    }
  }

  async start() {
    debug(this._moduleName, "starting");
    this.state = COLLECTOR_STATE.RUNNING;
    this._startedTime = this._exporter.start();
    debug(this._moduleName, "started");
  }

  async mute() {
    this.state = COLLECTOR_STATE.MUTED;
    debug(this._moduleName, "muted");
  }

  async unmute() {
    this.state = COLLECTOR_STATE.RUNNING;
    debug(this._moduleName, "unmuted");
  }

  async stop(forced) {
    debug(this._moduleName, `stopping${forced ? " by watchdog" : ""}...`);
    this._stoppedTime = this._exporter.stop();
    this.state = COLLECTOR_STATE.IDLE;

    if (this._config.ticket) {
      const { ticket } = this._exporter;
      this.fireOnTicket(ticket);
    }
    this._exporter.reset();
    debug(this._moduleName, "stopped");
  }

  registerCallback(name, callback, context) {
    if (name in this._callbacks) {
      this._callbacks[name] = {
        callback,
        context,
      };
      debug(this._moduleName, `registered callback '${name}'`);
    } else {
      error(
        this._moduleName,
        `can't register callback for '${name}' - not found`,
      );
    }
  }

  unregisterCallback(name) {
    if (name in this._callbacks) {
      this._callbacks[name] = null;
      delete this._callbacks[name];
      debug(this._moduleName, `unregistered callback '${name}'`);
    } else {
      error(
        this._moduleName,
        `can't unregister callback for '${name}' - not found`,
      );
    }
  }

  fireOnReport(report) {
    if (this._callbacks.onreport) {
      call(
        this._callbacks.onreport.callback,
        this._callbacks.onreport.context,
        report,
      );
    }
  }

  fireOnTicket(ticket) {
    if (this._callbacks.onticket) {
      call(
        this._callbacks.onticket.callback,
        this._callbacks.onticket.context,
        ticket,
      );
    }
  }

  updateConfig(config) {
    this._config = config;
    this._exporter.updateConfig(config);
  }

  get state() {
    return this._state;
  }

  set state(newState) {
    this._state = newState;
    debug(this._moduleName, `state changed to ${newState}`);
  }

  addCustomEvent(at, category, name, description, data) {
    this._exporter.addCustomEvent({
      at: typeof at === "object" ? at.toJSON() : at,
      category,
      name,
      description,
      data,
    });
  }

  async registerToPCEvents() {
    const { pc } = this._config;
    navigator.mediaDevices.ondevicechange = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        this.addCustomEvent(
          new Date().toJSON(),
          "device",
          "enumerate",
          "At least one device has been plugged or unplugged",
          { count: devices.length },
        );
        // eslint-disable-next-line no-empty
      } catch (err) {
        error(this._moduleName, "can't get devices");
      }
    };
    if (pc) {
      pc.oniceconnectionstatechange = () => {
        const value = pc.iceConnectionState;
        this.addCustomEvent(
          new Date().toJSON(),
          "call",
          "ice",
          "The ICE connection state has changed",
          { state: value },
        );
      };
      pc.onconnectionstatechange = () => {
        const value = pc.connectionState;
        this.addCustomEvent(
          new Date().toJSON(),
          "call",
          "connection",
          "The connection state has changed",
          { state: value },
        );
      };
      pc.onicegatheringstatechange = () => {
        const value = pc.iceGatheringState;
        this.addCustomEvent(
          new Date().toJSON(),
          "call",
          "gathering",
          "The ICE gathering state has changed",
          { state: value },
        );
      };
      pc.ontrack = (e) => {
        this.addCustomEvent(
          new Date().toJSON(),
          "call",
          "remote-track",
          "A new remote track has been received",
          { kind: e.track.kind, label: e.track.label, id: e.track.id },
        );
      };
      pc.onnegotiationneeded = () => {
        this.addCustomEvent(
          new Date().toJSON(),
          "call",
          "negotiation",
          "A negotiation is required",
          {},
        );
      };

      const receivers = pc.getReceivers();
      if (receivers && receivers.length > 0) {
        const receiver = receivers[0];
        const { transport } = receiver;
        if (transport) {
          const { iceTransport } = transport;
          if (iceTransport) {
            iceTransport.onselectedcandidatepairchange = () => {
              this.addCustomEvent(
                new Date().toJSON(),
                "call",
                "ice",
                "The selected candidates pair has changed",
                {},
              );
            };
          }
        }
      }
    }
  }
}
