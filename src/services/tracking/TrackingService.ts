/**
 * TrackingService — LOCAL-ONLY build.
 *
 * Cloud telemetry (POST https://deplaoapp.com/api/tracking/page) has been
 * disabled: start() is a no-op and no data ever leaves the machine.
 * Kept as a class so existing call sites (electron/main.ts) stay valid.
 */

import Logger from '../../utils/Logger';

class TrackingService {
  private static instance: TrackingService;

  public static getInstance(): TrackingService {
    if (!TrackingService.instance) {
      TrackingService.instance = new TrackingService();
    }
    return TrackingService.instance;
  }

  /** Local build: telemetry disabled — no-op. */
  public start(): void {
    Logger.log('[TrackingService] 🔇 Local build - telemetry cloud đã bị tắt');
    return;
  }

  /** No-op (nothing to stop). */
  public stop(): void {
    return;
  }
}

export default TrackingService;
