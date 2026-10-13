import com.mercadoenluz.app.GoveePacket;

public class GoveePacketTest {
    public static void main(String[] args) {
        byte[] on = GoveePacket.command(0x33, 0x01, 0x01);
        if (on.length != 20 || on[19] != (byte) 0x33) throw new AssertionError("Encendido");
        byte[] segments = GoveePacket.segments(255, 0, 0, 0x4001);
        if ((segments[12] & 0xff) != 1 || (segments[13] & 0xff) != 0x40) throw new AssertionError("Máscara");
        byte checksum = 0;
        for (byte value : segments) checksum ^= value;
        if (checksum != 0) throw new AssertionError("XOR");
        System.out.println("Paquetes H617A correctos");
    }
}
