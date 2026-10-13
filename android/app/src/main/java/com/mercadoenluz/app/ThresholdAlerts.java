package com.mercadoenluz.app;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Detecta cruces de ±1…5 %; nunca avisa al arrancar a mitad de sesión. */
public final class ThresholdAlerts {
    private final Map<String, Double> previous = new HashMap<>();
    private final Map<String, String> sessions = new HashMap<>();
    private final Set<String> fired = new HashSet<>();

    public ThresholdAlerts(Set<String> saved) { fired.addAll(saved); }

    public void resetBaseline() { previous.clear(); sessions.clear(); }

    public List<Integer> observe(String symbol, String session, double change) {
        List<Integer> crossed = new ArrayList<>();
        if (!Double.isFinite(change) || session == null || session.isEmpty()) return crossed;
        String oldSession = sessions.put(symbol, session);
        Double old = previous.put(symbol, change);
        if (!session.equals(oldSession)) {
            String prefix = symbol + "|";
            fired.removeIf(key -> key.startsWith(prefix) && !key.startsWith(prefix + session + "|"));
        }
        if (!session.equals(oldSession) || old == null) return crossed;
        for (int level = 1; level <= 5; level++) {
            int direction = change >= level && old < level ? 1 : change <= -level && old > -level ? -1 : 0;
            if (direction == 0) continue;
            String key = key(symbol, session, direction * level);
            if (!fired.contains(key)) crossed.add(direction * level);
        }
        return crossed;
    }

    public boolean mark(String symbol, String session, int level) {
        return fired.add(key(symbol, session, level));
    }

    public Set<String> saved() { return new HashSet<>(fired); }

    private static String key(String symbol, String session, int level) {
        return symbol + "|" + session + "|" + level;
    }
}
