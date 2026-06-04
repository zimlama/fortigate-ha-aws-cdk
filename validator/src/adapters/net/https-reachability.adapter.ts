import * as https from "https";
import { ReachabilityPort } from "../../ports/reachability.port";

/**
 * HTTPS adapter for ReachabilityPort.
 * Probes the FortiGate management interface on Port2 (INTERNAL subnet).
 *
 * A 200 response means the HTTPS management GUI is responding on Port2.
 * Any connection error (ECONNREFUSED, timeout, cert error) returns false.
 *
 * Excluded from unit test coverage — this is boundary I/O.
 * FortiGate typically uses a self-signed cert; rejectUnauthorized is disabled.
 */
export class HttpsReachability implements ReachabilityPort {
  private readonly timeoutMs: number;

  constructor(timeoutMs = 5000) {
    this.timeoutMs = timeoutMs;
  }

  isPort2MgmtReachable(ip: string): Promise<boolean> {
    return new Promise((resolve) => {
      const url = `https://${ip}:443`;

      const req = https.get(
        url,
        { rejectUnauthorized: false, timeout: this.timeoutMs },
        (res) => {
          resolve(res.statusCode !== undefined && res.statusCode < 500);
          res.resume(); // drain the response to free resources
        }
      );

      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
  }
}
