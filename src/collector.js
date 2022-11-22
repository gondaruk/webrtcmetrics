import Exporter from "./exporter";
import { extract, extractPassthroughFields } from "./extractor";
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
import { createCollectorId, call, findTrackInPeerConnectionById } from "./utils/helper";
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

  analyze(stats, previousReport, beforeLastReport, referenceReport, _refPC) {
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
          this.doInternalTreatment(data, previousReport, values, _refPC);
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

      // Extract passthrough fields
      const passthrough = extractPassthroughFields(stat, this._config.passthrough);
      Object.keys(passthrough).forEach((key) => {
        if (!(report.passthrough[key])) {
          report.passthrough[key] = {};
        }
        report.passthrough[key] = { ...report.passthrough[key], ...passthrough[key] };
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

  doInternalTreatment(data, previousReport, values, _pc) {
    const getValueFromReport = (property, report, withoutSSRC = false) => {
      if (withoutSSRC) {
        return ((data.type in report && property in report[data.type]) ? report[data.type][property] : null);
      }
      return ((data.type in report && data.ssrc in report[data.type] && property in report[data.type][data.ssrc]) ? report[data.type][data.ssrc][property] : null);
    };

    const getValueFromReportValues = (property, reportValues) => (
      reportValues.find((reportValue) => (property in reportValue.value ? reportValue.value[property] : null))
    );

    // track id changed = device changed
    const compareAndSendEventForDevice = (property) => {
      const currentTrackId = data.value[property];
      const previousTrackId = getValueFromReport(property, previousReport);
      const currentTrack = findTrackInPeerConnectionById(currentTrackId, _pc);
      const oldTrack = findTrackInPeerConnectionById(previousTrackId, _pc);
      let eventName = "trackstopormute";

      if (previousTrackId !== currentTrackId) {
        // Message when currentTrackId is null
        let message = `The existing outbound ${data.type} stream from ${oldTrack ? oldTrack.label : "unknown"} has been stopped or muted`;
        if (currentTrackId && previousTrackId) {
          // Message when trackId changed
          message = `The existing outbound ${data.type} device has been changed to ${currentTrack ? currentTrack.label : "unknown"}`;
          eventName = "trackupdate";
        } else if (!previousTrackId) {
          // Message when new trackId
          message = `A new outbound ${data.type} stream from ${currentTrack ? currentTrack.label : "unknown"} has been started or unmuted`;
          eventName = "trackstartorunmute";
        }

        this.addCustomEvent(
          new Date().toJSON(),
          "call",
          eventName,
          message,
          {
            ssrc: data.ssrc,
            value: currentTrackId,
            value_old: previousTrackId,
            kind: data.type,
            direction: "outbound",
          },
        );
      }
    };

    // width / framerate changed = resolution changed
    const compareAndSendEventForSize = (property) => {
      const size = data.value[property];
      const previousSize = getValueFromReport(property, previousReport);
      const currentActive = property.includes("out") ? getValueFromReportValues("active_out", values) : true;
      // Only send event for resolution and framerate if there is an active stream
      if (currentActive) {
        if (!previousSize || previousSize.width !== size.width) {
          this.addCustomEvent(
            new Date().toJSON(),
            "quality",
            "resolutionchange",
            `The resolution of the ${property.includes("out") ? "outbound" : "inbound"} ${data.type} stream has ${!previousSize || previousSize.width < size.width ? "increased" : "decreased"} to ${size.width}x${size.height}`,
            {
              direction: property.includes("out") ? "outbound" : "inbound",
              ssrc: data.ssrc,
              kind: data.type,
              size: `${size.width}x${size.height}`,
              size_old: `${previousSize ? previousSize.width : 0}x${previousSize ? previousSize.height : 0}`,
            },
          );
        }
        if (!previousSize || (previousSize.framerate !== undefined && Math.abs(previousSize.framerate - size.framerate) > 2)) {
          this.addCustomEvent(
            new Date().toJSON(),
            "quality",
            "frameratechange",
            `The framerate of the ${property.includes("out") ? "outbound" : "inbound"} ${data.type} stream has ${!previousSize || previousSize.framerate < size.framerate ? "increased" : "decreased"} to ${size.framerate}`,
            {
              direction: property.includes("out") ? "outbound" : "inbound",
              kind: data.type,
              ssrc: data.ssrc,
              framerate: size.framerate,
              framerate_old: previousSize ? previousSize.framerate : 0,
            },
          );
        }
      }
    };

    // MediaSourceId (outbound-rtp) becomes undefined = camera or microphone track removed (muted) or added again (unmuted)
    const compareAndSendEventForOutboundMediaSource = (property) => {
      const active = data.value[property];
      const previousActive = getValueFromReport(property, previousReport);
      if (active !== previousActive) {
        this.addCustomEvent(
          new Date().toJSON(),
          "call",
          "streamactivechange",
          `The ${property.includes("out") ? "outbound" : "inbound"} ${data.type} stream switched to ${active ? "active" : "inactive"}`,
          {
            direction: property.includes("out") ? "outbound" : "inbound",
            kind: data.type,
            ssrc: data.ssrc,
            active,
            active_old: previousActive,
          },
        );
      }
    };

    // VideoLimitation Change = cpu, bandwidth, other, none
    const compareAndSendEventForOutboundLimitation = (property) => {
      const limitation = data.value[property];
      const previousLimitation = getValueFromReport(property, previousReport);

      if (!previousLimitation || (limitation.reason !== previousLimitation.reason)) {
        this.addCustomEvent(
          new Date().toJSON(),
          "quality",
          "limitationchange",
          `The outbound video stream resolution is ${limitation.reason === "none" ? "no more limited" : `limited due to ${limitation.reason} reason`}`,
          {
            direction: property.includes("out") ? "outbound" : "inbound",
            kind: data.type,
            ssrc: data.ssrc,
            limitation: limitation.reason,
          },
        );
      }
    };

    // BytesSent changed a lot /10 or x10 = possibly track has been muted/unmuted
    const compareAndSendEventForBytes = (property) => {
      const bytesExchanged = data.value[property];
      const previousBytesExchanged = getValueFromReport(property, previousReport);
      const currentActive = property.includes("out") ? getValueFromReportValues("active_out", values) : true;
      const lowThreshold = previousBytesExchanged / 10;
      const highThreshold = previousBytesExchanged * 10;

      if (currentActive) {
        if (bytesExchanged > highThreshold || bytesExchanged < lowThreshold) {
          this.addCustomEvent(
            new Date().toJSON(),
            "quality",
            "peakdetected",
            `A peak has been detected for the ${property.includes("out") ? "outbound" : "inbound"} ${data.type} steam. Could be linked to a ${bytesExchanged > highThreshold ? "unmute" : "mute"}`,
            {
              direction: property.includes("out") ? "outbound" : "inbound",
              kind: data.type,
              ssrc: data.ssrc,
              peak: bytesExchanged > highThreshold ? "up" : "down",
              KBytes: bytesExchanged,
              oldKBytes: previousBytesExchanged,
            },
          );
        }
      }
    };

    const compareAndSendEventForSelectedCandidatePairChanged = (property) => {
      const selectedCandidatePairId = data.value[property];
      const previousSelectedCandidatePairId = getValueFromReport(property, previousReport, true);
      if (selectedCandidatePairId !== previousSelectedCandidatePairId) {
        this.addCustomEvent(
          new Date().toJSON(),
          "signal",
          "icechange",
          `The selected candidates pair changed to ${selectedCandidatePairId}`,
          {
            oldSelectedCandidatePairId: previousSelectedCandidatePairId,
            selectedCandidatePairId,
            type: "candidatepair",
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
        case "bytesSentChanged": {
          compareAndSendEventForBytes("delta_KBytes_out");
          break;
        }
        case "bytesReceivedChanged": {
          compareAndSendEventForBytes("delta_KBytes_in");
          break;
        }
        case "mediaSourceUpdated": {
          compareAndSendEventForOutboundMediaSource("active_out");
          break;
        }
        case "videoLimitationChanged": {
          compareAndSendEventForOutboundLimitation("limitation_out");
          break;
        }
        case "selectedPairChanged": {
          compareAndSendEventForSelectedCandidatePairChanged("selected_candidate_pair_id");
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
          const referenceReport = this.analyze(reports, null, null, null, this._config.pc);
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
        this._config.pc,
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
          "devicechange",
          "One device (at least) has been plugged or unplugged",
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
          "signal",
          "icechange",
          `The ICE connection state has changed to ${value}`,
          { state: value, type: "icestate" },
        );
      };
      pc.onconnectionstatechange = () => {
        const value = pc.connectionState;
        this.addCustomEvent(
          new Date().toJSON(),
          "signal",
          "icechange",
          `The connection state has changed to ${value}`,
          { state: value, type: "connection" },
        );
      };
      pc.onicegatheringstatechange = () => {
        const value = pc.iceGatheringState;
        this.addCustomEvent(
          new Date().toJSON(),
          "signal",
          "icechange",
          `The ICE gathering state has changed to ${value}`,
          { state: value, type: "gathering" },
        );
      };
      pc.ontrack = (e) => {
        this.addCustomEvent(
          new Date().toJSON(),
          "call",
          "streamchange",
          `A new inbound ${e.track.kind} stream has been started`,
          {
            kind: e.track.kind,
            label: e.track.label,
            id: e.track.id,
            direction: "inbound",
          },
        );
      };
      pc.onnegotiationneeded = () => {
        this.addCustomEvent(
          new Date().toJSON(),
          "signal",
          "icechange",
          "A negotiation is required",
          { type: "negotiation" },
        );
      };
    }
  }
}
