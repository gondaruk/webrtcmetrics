import Exporter from "./exporter";
import { computeMOS, computeEModelMOS, extract } from "./extractor";
import { ANALYZER_STATE, getDefaultMetric } from "./utils/helper";
import { debug, error, warn } from "./utils/log";

const moduleName = "analyzer    ";

const call = (fct, context, value) => {
  if (!context) {
    fct(value);
  } else {
    fct.call(context, value);
  }
};

export default class Analyzer {
  constructor(cfg) {
    this._callbacks = {
      onreport: null,
      onticket: null,
    };

    this._intervalId = null;
    this._stopTimeoutId = null;
    this._config = cfg;
    this._exporter = new Exporter(cfg);
    this._state = ANALYZER_STATE.IDLE;
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
    if (this._state === ANALYZER_STATE.RUNNING) {
      warn(moduleName, "start() - can't start - Already running!");
      return;
    }

    this._state = ANALYZER_STATE.RUNNING;
    debug(moduleName, `start() - state is ${this._state}`);

    if (!this._config.pc) {
      error(moduleName, "start() - no peer connection!");
      return;
    }

    const getStats = async () => {
      try {
        const reports = await this._config.pc.getStats();
        debug(moduleName, `getstats() - got report ${this._config.pname}#${this._exporter.getReportsNumber() + 1}`);

        // Take into account last report in case no report have been generated (eg: candidate-pair)
        const report = this.analyze(reports, this._exporter.getLastReport(), this._exporter.getBeforeLastReport(), this._exporter.getReferenceReport());

        this._exporter.addReport(report);
        this.fireOnReport(report);
      } catch (err) {
        error(moduleName, `getStats() - error ${err}`);
      }
    };

    const takeReferenceStat = async () => (
      new Promise((resolve, reject) => {
        setTimeout(async () => {
          try {
            const reports = await this._config.pc.getStats();
            debug(moduleName, `getstats() - got reference report for ${this._config.pname}`);
            const referenceReport = this.analyze(reports, null, null, null);
            this._exporter.saveReferenceReport(referenceReport);
            resolve();
          } catch (err) {
            reject(err);
          }
        }, this._config.startAfter);
      })
    );

    const takeStats = () => {
      const intervalId = setInterval(() => {
        getStats();
      }, this._config.refreshEvery);
      return intervalId;
    };

    const runWatchdog = () => {
      if (this._config.stopAfter === -1) {
        debug(moduleName, "start() - watchdog disabled - stats will be stopped when calling stop()");
        return null;
      }

      debug(moduleName, `start() - watchdog will stop the stats after ${this._config.stopAfter}ms`);
      const stopTimeoutId = setTimeout(() => {
        debug(moduleName, "start() - watchdog called - stop the stats");
        this.stop();
      }, this._config.stopAfter);
      return stopTimeoutId;
    };

    if (this._intervalId) {
      debug(moduleName, `start() - clear analyzer with id ${this._intervalId}`);
      clearInterval(this._intervalId);
    }

    if (this._stopTimeoutId) {
      debug(moduleName, `start() - clear watchdog with id ${this._stopTimeoutId}`);
      clearInterval(this._stopTimeoutId);
    }

    debug(moduleName, `start() - analyzing will start after ${this._config.startAfter}ms`);
    try {
      await takeReferenceStat();
      this._exporter.start();
      debug(moduleName, "start() - analyzing started");
      this._intervalId = takeStats();
      this._stopTimeoutId = runWatchdog();
    } catch (err) {
      error(moduleName, `Can't grab stats ${err}`);
    }
  }

  stop() {
    if (this._state === ANALYZER_STATE.IDLE) {
      warn(moduleName, "stop() - can't stop - Already stopped!");
      return;
    }

    this._state = ANALYZER_STATE.IDLE;
    debug(moduleName, `stop() - state is ${this._state}`);

    if (this._intervalId) {
      clearInterval(this._intervalId);
    }

    if (this._stopTimeoutId) {
      clearTimeout(this._stopTimeoutId);
    }

    const ticket = this._exporter.stop();
    if (this._config.ticket) {
      this.fireOnTicket(ticket);
    }
    this._exporter.reset();
  }

  registerCallback(name, callback, context) {
    if (name in this._callbacks) {
      this._callbacks[name] = { callback, context };
      debug(moduleName, `registered callback '${name}'`);
    } else {
      error(moduleName, `can't register callback for '${name}' - already exists`);
    }
  }

  unregisterCallback(name) {
    if (name in this._callbacks) {
      this._callbacks[name] = null;
      delete this._callbacks[name];
      debug(moduleName, `unregistered callback '${name}'`);
    } else {
      error(moduleName, `can't unregister callback for '${name}' - not found`);
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
