package com.mercadoenluz.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;

/** Mantiene la cartera y el enlace BLE activos aunque la pantalla se bloquee. */
public final class LedService extends Service {
    private static final String CHANNEL_ID = "led_connection";
    private static final String ACTION_STOP = "com.mercadoenluz.app.STOP_UPDATES";
    private static final int NOTIFICATION_ID = 617;
    private static final long WAKE_TIMEOUT_MS = 10 * 60 * 1000L;
    private static final long WAKE_RENEW_MS = 8 * 60 * 1000L;
    private static LocalApi sharedApi;

    private LocalApi runningApi;
    private PowerManager.WakeLock wakeLock;
    private final Handler wakeHandler = new Handler(Looper.getMainLooper());
    private final Runnable renewWakeLock = new Runnable() {
        @Override public void run() {
            if (wakeLock == null) return;
            if (wakeLock.isHeld()) wakeLock.release();
            wakeLock.acquire(WAKE_TIMEOUT_MS);
            wakeHandler.postDelayed(this, WAKE_RENEW_MS);
        }
    };
    private boolean powerChecked;

    static synchronized LocalApi getApi(Context context) {
        if (sharedApi == null) sharedApi = new LocalApi(context.getApplicationContext());
        return sharedApi;
    }

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager notifications = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        notifications.createNotificationChannel(new NotificationChannel(
            CHANNEL_ID, getString(R.string.strip_connection), NotificationManager.IMPORTANCE_LOW));
        Intent launch = new Intent(this, MainActivity.class);
        PendingIntent content = PendingIntent.getActivity(this, 0, launch,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1,
            new Intent(this, LedService.class).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.updating_portfolio))
            .setContentIntent(content)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(0, getString(R.string.stop), stop)
            .build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        if (power != null) {
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MercadoEnLuz:LedUpdates");
            wakeLock.setReferenceCounted(false);
            renewWakeLock.run();
        }
        runningApi = getApi(this);
        runningApi.start();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!powerChecked) {
            powerChecked = true;
            runningApi.checkPower();
        }
        return START_STICKY;
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() {
        wakeHandler.removeCallbacks(renewWakeLock);
        if (runningApi != null) runningApi.stop();
        synchronized (LedService.class) {
            if (sharedApi == runningApi) sharedApi = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }
}
