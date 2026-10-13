# Figura: Mercado en luz

Una figura isométrica interactiva que explica la app sin necesidad de tener la
tira: una esquina de dormitorio con una Govee H617A de 15 segmentos en el borde
del techo. Cada empresa de la cartera ocupa un tramo verde o rojo, y una fila de
teclas, una por empresa, controla la tira en tiempo real. Un MacBook sobre la
cama y un móvil en la mesilla muestran la app.

- **Toca una tecla:** su tramo destella como en la función Destellos de la app y suena una nota suave.
- **Arrastra una tecla** (o usa Alt + flechas): la tira se reasigna como en el editor de cartera.
- Sin interacción, un pulso suave recorre las teclas una a una; el orden solo cambia cuando alguien arrastra.

Los colores, el reparto de segmentos y la media de la cartera salen de
`model.mjs`, con la misma cartera y las mismas reglas que la app. Las
variaciones son ilustrativas (mitad verde, mitad roja); la figura no hace
llamadas de red.

## Archivos

| Archivo | Contenido |
| --- | --- |
| `market-in-light.html` | Página autocontenida (inglés, tema oscuro) |
| `market-in-light-light.html`, `-es.html`, `-es-light.html` | Tema claro y versiones en español |
| `media/market-in-light.gif` · `.mp4` · `.png` | Bucle para el README y LinkedIn, y una imagen fija |
| `build.mjs` | Geometría de la escena (SVG isométrico) |
| `live.js` | Interacción y shader WebGL de la luz sobre paredes y muebles |
| `model.mjs` | Cartera, segmentos, colores y paquete Bluetooth |
| `kit/` | Kit isométrico usado para dibujar la escena |

## Reconstruir

```bash
cd docs/figure
node build.mjs && node build.mjs --light && node build.mjs --es && node build.mjs --es --light  # cada variante por separado
```

Sin WebGL, la página dibuja un lavado de color en SVG bajo cada segmento.
