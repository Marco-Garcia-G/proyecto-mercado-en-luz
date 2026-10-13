import com.mercadoenluz.app.ThresholdAlerts;
import java.util.HashSet;
import java.util.List;

public final class ThresholdAlertsTest {
    private static void expect(List<Integer> actual, List<Integer> expected) {
        if (!actual.equals(expected)) throw new AssertionError(actual + " != " + expected);
    }

    public static void main(String[] args) {
        ThresholdAlerts alerts = new ThresholdAlerts(new HashSet<>());
        expect(alerts.observe("AAPL", "2026-09-23", 0.5), List.of());
        expect(alerts.observe("AAPL", "2026-09-23", 2.2), List.of(1, 2));
        alerts.mark("AAPL", "2026-09-23", 1);
        alerts.mark("AAPL", "2026-09-23", 2);
        expect(alerts.observe("AAPL", "2026-09-23", 0.4), List.of());
        expect(alerts.observe("AAPL", "2026-09-23", 2.1), List.of());
        expect(alerts.observe("AAPL", "2026-09-23", -3.1), List.of(-1, -2, -3));
        alerts.mark("AAPL", "2026-09-23", -1);
        alerts.mark("AAPL", "2026-09-23", -2);
        alerts.mark("AAPL", "2026-09-23", -3);
        expect(alerts.observe("AAPL", "2026-09-23", -0.2), List.of());
        expect(alerts.observe("AAPL", "2026-09-23", -3.1), List.of());
        expect(alerts.observe("TSM", "2026-09-23", 0.1), List.of());
        expect(alerts.observe("TSM", "2026-09-23", 1.2), List.of(1));
        ThresholdAlerts restored = new ThresholdAlerts(alerts.saved());
        expect(restored.observe("AAPL", "2026-09-23", 0.2), List.of());
        expect(restored.observe("AAPL", "2026-09-23", 2.2), List.of());
        expect(alerts.observe("AAPL", "2026-09-24", 2.1), List.of());
        expect(alerts.observe("AAPL", "2026-09-24", 3.2), List.of(3));
        System.out.println("ThresholdAlerts OK");
    }
}
