import Exporter from "./exporter";
import { computeMOS, computeEModelMOS, extract } from "./extractor";
import { ANALYZER_STATE, createCollectorId, getDefaultMetric } from "./utils/helper";
import {
  debug,
  error,
  info,
  warn,
} from "./utils/log";

const call = (fct, context, value) => {
  if (!context) {
    fct(value);
  } else {
    fct.call(context, value);
  }
};

export default class Collector {
  constructor(cfg, refProbeId) {
    this._callbacks = {
      onreport: null,
      onticket: null,
    };

    this._intervalId = null;
    this._id = createCollectorId();
    this._moduleName = this._id;
    this._probeId = refProbeId;
    this._startedTime = null;
    this._config = cfg;
    this._exporter = new Exporter(cfg);
    this._state = ANALYZER_STATE.IDLE;
    info(this._moduleName, `new collector created for probe ${this._probeId}`);
  }

  analyze(stats, previousReport, beforeLastReport, referenceReport) {
    const report = getDefaultMetric(previousReport);

    report.pname = this._config.pname;
    report.call_id = this._config.cid;
    report.user_id = this._config.uid;
    report.count = previousReport ? previousReport.count + 1 : 1;

    let timestamp = null;
    stats.forEach((stat) => {
      if (!timestamp && stat.timestamp) {
        timestamp = stat.timestamp;
      }
      const values = extract(stat, report, report.pname, referenceReport);
      values.forEach((data) => {
        if (data.value && data.type) {
          Object.keys(data.value).forEach((key) => {
            report[data.type][key] = data.value[key];
          });
        }
      });
    });
    report.timestamp = timestamp;
    report.audio.mos_emodel = computeEModelMOS(report, "audio", previousReport, beforeLastReport);
    report.audio.mos = computeMOS(report, "audio", previousReport, beforeLastReport);
    return report;
  }

  async start() {
    const getStats = async (waitTime) => {
      try {
        if (this._state === ANALYZER_STATE.RUNNING) {
          // Take into account last report in case no report have been generated (eg: candidate-pair)
          const preTime = Date.now();
          const reports = await this._config.pc.getStats();
          const report = this.analyze(reports, this._exporter.getLastReport(), this._exporter.getBeforeLastReport(), this._exporter.getReferenceReport());
          const postTime = Date.now();
          report.experimental.time_to_measure_ms = postTime - preTime;
          report.experimental.time_to_wait_ms = waitTime;
          this._exporter.addReport(report);
          debug(this._moduleName, `got report for probe ${this._probeId}#${this._exporter.getReportsNumber() + 1}`);
          this.fireOnReport(report);
        } else {
          debug(this._moduleName, `report discarded (too late) for probe ${this._probeId}`);
        }
      } catch (err) {
        error(this._moduleName, `got error ${err}`);
      }
    };

    const takeReferenceStat = async () => (
      new Promise((resolve, reject) => {
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
            debug(this._moduleName, `got reference report for probe ${this._probeId}`);
            resolve();
          } catch (err) {
            reject(err);
          }
        }, this._config.startAfter);
      })
    );

    const shouldCollectStats = () => {
      if (this._state === ANALYZER_STATE.IDLE) {
        // Don't collect when collector is not running
        return false;
      }
      if (this._config.stopAfter < 0) {
        // Don 't stop collect automatically when stopAfter is not set
        return true;
      }
      return (Date.now() < this._startedTime.getTime() + this._config.stopAfter);
    };

    const collectStats = async () => (
      new Promise((resolve) => {
        const preTime = Date.now();
        this._intervalId = setTimeout(async () => {
          const waitTime = Date.now() - preTime;
          if (this._state === ANALYZER_STATE.RUNNING) {
           await getStats(waitTime);
           resolve();
          }
         }, this._config.refreshEvery);
      })
    );

    if (!this._config.pc) {
      error(this._moduleName, "can't start - no peer connection!");
      return;
    }

    if (this._state === ANALYZER_STATE.RUNNING) {
      warn(this._moduleName, "can't start - already running!");
      return;
    }

    info(this._moduleName, "starting...");
    this._state = ANALYZER_STATE.RUNNING;
    if (this._intervalId) {
      warn(this._moduleName, "clean previous collector");
      clearInterval(this._intervalId);
      this._intervalId = null;
    }

    debug(this._moduleName, `delay start after ${this._config.startAfter}ms`);

    try {
      info(this._moduleName, "started");
      await takeReferenceStat();
      this._startedTime = this._exporter.start();
      while (shouldCollectStats()) {
        await collectStats();
      }
      this.stop(true);
    } catch (err) {
      error(this._moduleName, `can't grab stats ${err}`);
    }
  }

  stop(forced) {
    if (this._state === ANALYZER_STATE.IDLE) {
      warn(this._moduleName, "can't stop - already stopped!");
      return;
    }

    this._state = ANALYZER_STATE.IDLE;
    info(this._moduleName, `stopping${forced ? " by watchdog" : ""}...`);

    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }

    const ticket = this._exporter.stop();
    if (this._config.ticket) {
      this.fireOnTicket(ticket);
    }
    this._exporter.reset();
    info(this._moduleName, "stopped");
  }

  registerCallback(name, callback, context) {
    if (name in this._callbacks) {
      this._callbacks[name] = { callback, context };
      debug(this._moduleName, `registered callback '${name}'`);
    } else {
      error(this._moduleName, `can't register callback for '${name}' - already exists`);
    }
  }

  unregisterCallback(name) {
    if (name in this._callbacks) {
      this._callbacks[name] = null;
      delete this._callbacks[name];
      debug(this._moduleName, `unregistered callback '${name}'`);
    } else {
      error(this._moduleName, `can't unregister callback for '${name}' - not found`);
    }
  }

  fireOnReport(report) {
    if (this._callbacks.onreport) {
      call(this._callbacks.onreport.callback, this._callbacks.onreport.context, report);
    }
  }

  fireOnTicket(ticket) {
    if (this._callbacks.onticket) {
      call(this._callbacks.onticket.callback, this._callbacks.onticket.context, ticket);
    }
  }

  updateConfig(config) {
    this._config = config;
    this._exporter.updateConfig(config);
  }

  get state() {
    return this._state;
  }
}