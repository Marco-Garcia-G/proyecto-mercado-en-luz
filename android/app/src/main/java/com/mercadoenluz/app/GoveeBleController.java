package com.mercadoenluz.app;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothStatusCodes;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.SystemClock;

import java.util.UUID;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** Control Bluetooth para modelos Govee que anuncian el protocolo segmentado 0x33 0x05 0x15. */
public final class GoveeBleController {
    public static final String[] SUPPORTED_MODELS = { "H617A", "H617C", "H6053", "H6072", "H6102", "H6199" };
    public interface Listener { void update(boolean known, boolean on, boolean busy, String error); }
    public interface CarouselListener { void update(int assetIndex, int position, int windowStart); }

    private static final UUID WRITE = UUID.fromString("00010203-0405-0607-0809-0a0b0c0d2b11");
    private static final UUID NOTIFY = UUID.fromString("00010203-0405-0607-0809-0a0b0c0d2b10");
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private final Context context;
    private final SharedPreferences preferences;
    private final Listener listener;
    private final CarouselListener carouselListener;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic writeCharacteristic;
    private volatile CountDownLatch connected;
    private volatile CountDownLatch discovered;
    private volatile CountDownLatch notificationReady;
    private volatile CountDownLatch powerReply;
    private volatile Boolean reportedPower;
    private volatile boolean lastKnown;
    private volatile boolean lastOn;
    private volatile boolean carouselRunning;
    private volatile int[] carouselColors = new int[0];
    private volatile String selectedModel;

    public GoveeBleController(Context context, Listener listener) {
        this(context, listener, (assetIndex, position, windowStart) -> { });
    }

    public GoveeBleController(Context context, Listener listener, CarouselListener carouselListener) {
        this.context = context.getApplicationContext();
        this.preferences = context.getSharedPreferences("device", Context.MODE_PRIVATE);
        this.selectedModel = preferences.getString("model", "H617A");
        if (!isSupportedModel(selectedModel)) this.selectedModel = "H617A";
        this.listener = listener;
        this.carouselListener = carouselListener;
    }

    public void queryPower() { worker.execute(() -> runSession(null, null)); }
    public String selectedModel() { return selectedModel; }
    public static boolean isSupportedModel(String model) {
        for (String allowed : SUPPORTED_MODELS) if (allowed.equals(model)) return true;
        return false;
    }
    public void selectModel(String model) {
        if (!isSupportedModel(model)) throw new IllegalArgumentException("Modelo no admitido");
        if (model.equals(selectedModel)) return;
        carouselRunning = false;
        selectedModel = model;
        preferences.edit().putString("model", model).apply();
        worker.execute(() -> {
            if (gatt != null) { gatt.disconnect(); gatt.close(); gatt = null; }
            writeCharacteristic = null;
            lastKnown = false;
            listener.update(false, false, false, "");
            runSession(null, null);
        });
    }
    public void shutdown() { carouselRunning = false; worker.shutdownNow(); }
    public void setPower(boolean on) {
        carouselRunning = false;
        worker.execute(() -> runSession(on, null));
    }
    public void showColors(int redMask, int greenMask, int blackMask) {
        showPalette(new int[] { 0xff0000, redMask, 0x00ff00, greenMask, 0x000000, blackMask });
    }
    public void showPalette(int[] colorMasks) {
        worker.execute(() -> runSession(null, colorMasks.clone()));
    }

    public void flash(int mask, int rgb, int seconds, Runnable success) {
        if (carouselRunning) return;
        worker.execute(() -> runSession(null, null, new int[] { mask, rgb, seconds }, success));
    }

    public void setCarousel(int[] colors, boolean enabled) {
        carouselColors = colors == null ? new int[0] : colors.clone();
        if (enabled) {
            if (!carouselRunning) {
                carouselRunning = true;
                worker.execute(this::runCarouselSession);
            }
        } else {
            carouselRunning = false;
        }
    }

    @SuppressLint("MissingPermission")
    private void runCarouselSession() {
        try {
            BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
            if (adapter == null || !adapter.isEnabled()) throw new IllegalStateException("Activa el Bluetooth del móvil");
            BluetoothDevice device = findDevice(adapter);
            connected = new CountDownLatch(1);
            discovered = new CountDownLatch(1);
            notificationReady = new CountDownLatch(1);
            gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE);
            if (gatt == null || !connected.await(12, TimeUnit.SECONDS) || !discovered.await(12, TimeUnit.SECONDS)) {
                throw new IllegalStateException("No se pudo conectar con la " + selectedModel);
            }
            if (writeCharacteristic == null) throw new IllegalStateException("La tira no ofrece el control esperado");
            if (!notificationReady.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("No se pudo leer el estado de la tira");
            Boolean observed = query();
            lastKnown = true;
            lastOn = Boolean.TRUE.equals(observed);
            listener.update(true, lastOn, false, "");
            if (!lastOn) return;
            write(GoveePacket.command(0x33, 0x04, 100));
            SystemClock.sleep(250);
            write(GoveePacket.segments(0, 0, 0, 0x7fff));
            int windowStart = 0;
            int shift = 0;
            while (carouselRunning && lastOn) {
                int[] colors = carouselColors;
                if (colors.length == 0) break;
                int activeCount = Math.min(15, colors.length);
                int[] baseRoute = new int[15];
                int assigned = 0;
                int each = 15 / activeCount;
                int remainder = 15 % activeCount;
                for (int index = 0; index < activeCount; index++) {
                    int assetIndex = (windowStart + index) % colors.length;
                    int count = each + (index < remainder ? 1 : 0);
                    for (int j = 0; j < count; j++) baseRoute[assigned++] = assetIndex;
                }
                for (int frame = 0; frame < 15 && carouselRunning && lastOn; frame++) {
                    Map<Integer, Integer> masks = new TreeMap<>();
                    int currentAsset = -1;
                    for (int position = 0; position < 15; position++) {
                        int routeIndex = (position - shift + 15) % 15;
                        int assetIndex = baseRoute[routeIndex];
                        if (position == 0) currentAsset = assetIndex;
                        int color = colors[assetIndex];
                        masks.merge(color, 1 << position, (left, right) -> left | right);
                    }
                    carouselListener.update(currentAsset, shift, windowStart);
                    for (Map.Entry<Integer, Integer> entry : masks.entrySet()) {
                        int rgb = entry.getKey();
                        write(GoveePacket.segments((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff, entry.getValue()));
                    }
                    SystemClock.sleep(1200);
                    shift = (shift + 1) % 15;
                }
                if (colors.length > 15) windowStart = (windowStart + 1) % colors.length;
            }
        } catch (SecurityException error) {
            lastKnown = false;
            listener.update(false, false, false, "Permite el acceso a Bluetooth para conectar la tira");
        } catch (Exception error) {
            lastKnown = false;
            forgetSelectedAddress();
            listener.update(false, false, false, error.getMessage() == null ? "Error de Bluetooth" : error.getMessage());
        } finally {
            carouselRunning = false;
            carouselListener.update(-1, -1, 0);
            if (gatt != null) { gatt.disconnect(); gatt.close(); gatt = null; }
            writeCharacteristic = null;
        }
    }

    @SuppressLint("MissingPermission") // Los permisos se solicitan antes de llamar al controlador.
    private void runSession(Boolean desiredPower, int[] colors) {
        runSession(desiredPower, colors, null, null);
    }

    @SuppressLint("MissingPermission")
    private void runSession(Boolean desiredPower, int[] colors, int[] flash, Runnable success) {
        listener.update(lastKnown, lastOn, true, "");
        try {
            BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
            if (adapter == null || !adapter.isEnabled()) throw new IllegalStateException("Activa el Bluetooth del móvil");
            BluetoothDevice device = findDevice(adapter);
            connected = new CountDownLatch(1);
            discovered = new CountDownLatch(1);
            notificationReady = new CountDownLatch(1);
            gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE);
            if (gatt == null || !connected.await(12, TimeUnit.SECONDS) || !discovered.await(12, TimeUnit.SECONDS)) {
                throw new IllegalStateException("No se pudo conectar con la " + selectedModel);
            }
            if (writeCharacteristic == null) throw new IllegalStateException("La tira no ofrece el control esperado");
            if (!notificationReady.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("No se pudo leer el estado de la tira");
            Boolean observed;
            if (desiredPower != null) {
                observed = null;
                for (int attempt = 0; attempt < 3 && !desiredPower.equals(observed); attempt++) {
                    for (int repeat = 0; repeat < 3; repeat++) {
                        write(GoveePacket.command(0x33, 0x01, desiredPower ? 1 : 0));
                        SystemClock.sleep(70);
                    }
                    SystemClock.sleep(380);
                    observed = query();
                }
                if (!desiredPower.equals(observed)) throw new IllegalStateException("La tira no confirmó el cambio de estado");
            } else {
                observed = query();
            }
            if (colors != null && Boolean.TRUE.equals(observed)) {
                write(GoveePacket.command(0x33, 0x04, 100));
                SystemClock.sleep(300);
                for (int i = 0; i + 1 < colors.length; i += 2) {
                    int rgb = colors[i];
                    int mask = colors[i + 1];
                    if (mask == 0) continue;
                    write(GoveePacket.segments((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff, mask));
                    SystemClock.sleep(400);
                }
            }
            if (flash != null && Boolean.TRUE.equals(observed)) {
                int mask = flash[0];
                int rgb = flash[1];
                byte[] restore = GoveePacket.segments((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff, mask);
                try {
                    for (int i = 0; i < flash[2]; i++) {
                        write(GoveePacket.segments(0, 0, 0, mask));
                        SystemClock.sleep(500);
                        write(restore);
                        SystemClock.sleep(500);
                    }
                } finally {
                    write(restore);
                }
                if (success != null) success.run();
            }
            lastKnown = true;
            lastOn = Boolean.TRUE.equals(observed);
            listener.update(lastKnown, lastOn, false, "");
        } catch (SecurityException error) {
            lastKnown = false;
            listener.update(false, false, false, "Permite el acceso a Bluetooth para conectar la tira");
        } catch (Exception error) {
            lastKnown = false;
            forgetSelectedAddress();
            listener.update(false, false, false, error.getMessage() == null ? "Error de Bluetooth" : error.getMessage());
        } finally {
            if (gatt != null) { gatt.disconnect(); gatt.close(); gatt = null; }
            writeCharacteristic = null;
        }
    }

    @SuppressLint("MissingPermission")
    private BluetoothDevice findDevice(BluetoothAdapter adapter) throws InterruptedException {
        String address = preferences.getString("address_" + selectedModel,
            "H617A".equals(selectedModel) ? preferences.getString("h617a_address", null) : null);
        if (address != null) {
            try { return adapter.getRemoteDevice(address); }
            catch (IllegalArgumentException ignored) { forgetSelectedAddress(); }
        }
        BluetoothLeScanner scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) throw new IllegalStateException("No se puede buscar la tira por Bluetooth");
        CountDownLatch found = new CountDownLatch(1);
        BluetoothDevice[] match = new BluetoothDevice[1];
        int[] bestRssi = { Integer.MIN_VALUE };
        ScanCallback scan = new ScanCallback() {
            @Override public void onScanResult(int type, ScanResult result) {
                String name = result.getScanRecord() == null ? null : result.getScanRecord().getDeviceName();
                if (name == null || !name.toUpperCase(Locale.ROOT).contains(selectedModel)) return;
                synchronized (match) {
                    // Con varias tiras del mismo modelo, se queda con la de mejor señal.
                    if (result.getRssi() > bestRssi[0]) {
                        bestRssi[0] = result.getRssi();
                        match[0] = result.getDevice();
                    }
                }
                found.countDown();
            }
            @Override public void onScanFailed(int code) { found.countDown(); }
        };
        scanner.startScan(scan);
        try {
            // Tras la primera coincidencia, escucha un momento más para comparar tiras cercanas.
            if (found.await(10, TimeUnit.SECONDS)) SystemClock.sleep(1500);
        } finally { scanner.stopScan(scan); }
        BluetoothDevice nearest;
        synchronized (match) { nearest = match[0]; }
        if (nearest == null) throw new IllegalStateException("No encuentro la " + selectedModel + ". Acerca el móvil a la tira");
        preferences.edit().putString("address_" + selectedModel, nearest.getAddress()).apply();
        return nearest;
    }

    private void forgetSelectedAddress() {
        SharedPreferences.Editor editor = preferences.edit().remove("address_" + selectedModel);
        if ("H617A".equals(selectedModel)) editor.remove("h617a_address");
        editor.apply();
    }

    @SuppressLint("MissingPermission")
    private Boolean query() throws InterruptedException {
        reportedPower = null;
        powerReply = new CountDownLatch(1);
        write(GoveePacket.command(0xAA, 0x01, 0x00));
        if (!powerReply.await(2, TimeUnit.SECONDS)) throw new IllegalStateException("La tira no respondió a la consulta");
        return reportedPower;
    }

    @SuppressLint("MissingPermission")
    private void write(byte[] bytes) {
        if (gatt == null || writeCharacteristic == null) throw new IllegalStateException("Bluetooth desconectado");
        boolean accepted;
        if (Build.VERSION.SDK_INT >= 33) {
            accepted = gatt.writeCharacteristic(writeCharacteristic, bytes, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE) == BluetoothStatusCodes.SUCCESS;
        } else {
            writeCharacteristic.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            writeCharacteristic.setValue(bytes);
            accepted = gatt.writeCharacteristic(writeCharacteristic);
        }
        if (!accepted) throw new IllegalStateException("La tira no aceptó el comando Bluetooth");
    }

    private final BluetoothGattCallback callback = new BluetoothGattCallback() {
        @SuppressLint("MissingPermission")
        @Override public void onConnectionStateChange(BluetoothGatt device, int status, int newState) {
            if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
                connected.countDown();
                device.discoverServices();
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED && connected != null) {
                connected.countDown();
                if (discovered != null) discovered.countDown();
            }
        }

        @SuppressLint("MissingPermission")
        @Override public void onServicesDiscovered(BluetoothGatt device, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                for (android.bluetooth.BluetoothGattService service : device.getServices()) {
                    if (service.getCharacteristic(WRITE) != null) writeCharacteristic = service.getCharacteristic(WRITE);
                    BluetoothGattCharacteristic notify = service.getCharacteristic(NOTIFY);
                    if (notify == null) continue;
                    device.setCharacteristicNotification(notify, true);
                    BluetoothGattDescriptor descriptor = notify.getDescriptor(CCCD);
                    if (descriptor == null) { notificationReady.countDown(); continue; }
                    if (Build.VERSION.SDK_INT >= 33) {
                        device.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                    } else {
                        descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                        device.writeDescriptor(descriptor);
                    }
                }
            }
            discovered.countDown();
        }

        @Override public void onDescriptorWrite(BluetoothGatt device, BluetoothGattDescriptor descriptor, int status) {
            if (notificationReady != null) notificationReady.countDown();
        }

        private void readPower(byte[] value) {
            if (value != null && value.length >= 3 && (value[0] & 0xff) == 0xaa && (value[1] & 0xff) == 1) {
                reportedPower = value[2] == 1;
                if (powerReply != null) powerReply.countDown();
            }
        }

        @Override public void onCharacteristicChanged(BluetoothGatt device, BluetoothGattCharacteristic characteristic) {
            if (NOTIFY.equals(characteristic.getUuid())) readPower(characteristic.getValue());
        }

        @Override public void onCharacteristicChanged(BluetoothGatt device, BluetoothGattCharacteristic characteristic, byte[] value) {
            if (NOTIFY.equals(characteristic.getUuid())) readPower(value);
        }
    };
}
