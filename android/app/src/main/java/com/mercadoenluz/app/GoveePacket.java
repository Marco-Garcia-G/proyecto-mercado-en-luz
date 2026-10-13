package com.mercadoenluz.app;

/** Paquetes de 20 bytes comprobados con la H617A; sin dependencias de Android. */
public final class GoveePacket {
    private GoveePacket() {}

    public static byte[] command(int... payload) {
        if (payload.length > 19) throw new IllegalArgumentException("Payload demasiado largo");
        byte[] packet = new byte[20];
        for (int i = 0; i < payload.length; i++) packet[i] = (byte) payload[i];
        for (int i = 0; i < 19; i++) packet[19] ^= packet[i];
        return packet;
    }

    public static byte[] segments(int red, int green, int blue, int mask) {
        if ((mask & ~0x7fff) != 0) throw new IllegalArgumentException("Segmentos fuera de 0..14");
        byte[] packet = command(0x33, 0x05, 0x15, 0x01, red, green, blue);
        packet[12] = (byte) mask;
        packet[13] = (byte) (mask >>> 8);
        packet[19] = 0;
        for (int i = 0; i < 19; i++) packet[19] ^= packet[i];
        return packet;
    }
}
