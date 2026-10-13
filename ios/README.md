# Mercado en luz · iPhone, iPad y Mac

Proyecto nativo para iPhone y iPad (iOS 15 o posterior) y Mac Catalyst. Reutiliza
la interfaz de `app/web/`, pero guarda la cartera en cada dispositivo y utiliza Swift
para cotizaciones y Core Bluetooth para modelos Govee compatibles. El iPhone y
el iPad no necesitan el Mac una vez instalados.

## Instalar para probar

1. Instala Xcode completo desde la Mac App Store. Las Command Line Tools solas
   no pueden compilar una app iPhone.
2. Abre `ios/MercadoEnLuz.xcodeproj` en Xcode.
3. En *Signing & Capabilities*, elige tu equipo de desarrollo. Si Xcode indica
   que el identificador ya existe, cambia el *Bundle Identifier* por uno propio.
4. Elige iPhone, iPad o **My Mac (Mac Catalyst)** como destino y pulsa **Run ▶**.
   En el dispositivo, acepta la confianza del ordenador y el permiso de Bluetooth.
5. Cierra antes la app Govee y el programa del Mac; solo uno debe controlar la
   tira a la vez. La primera búsqueda de la tira se hace con la app abierta.

En la pantalla inicial, bajo el botón de encendido, selecciona el modelo de la
tira. H617A conserva la configuración existente. H617C, H6053, H6072, H6102 y
H6199 usan el mismo protocolo segmentado documentado por la comunidad y están
marcados como **beta** hasta comprobarlos con cada tira real. Los dispositivos
que no anuncien ese protocolo no son compatibles con esta versión.

El icono iPhone reproduce las dos luces roja y verde de la marca. La carpeta
`app/web/` se incluye como recurso del proyecto: los cambios visuales futuros se
comparten con Android sin copiarlos a mano.

## Funciones y límites

- Incluye encendido, consulta de estado, color por bloques, búsqueda y edición
  de cartera, media igual o ponderada, objetivos, Ambiente, Destellos y carrusel.
- Se conservan en cada dispositivo la cartera, ajustes de funciones, objetivos, cola del
  carrusel y últimas cotizaciones. Las tres carteras se guardan localmente.
  No hay sincronización automática entre iPhone, iPad, Android o Mac.
- `QuoteProvider.swift` usa la misma fuente de desarrollo provisional que
  Android; necesita un proveedor con derechos adecuados antes de publicar.
- Dividendos y resultados se muestran como no disponibles, igual que Android.
- Core Bluetooth usa `bluetooth-central` y restauración de estado para recuperar
  conexiones. Una tarea de actualización pide oportunidades para renovar
  cotizaciones en segundo plano, pero **iOS decide cuándo la ejecuta**. No hay
  garantía de actualizar precios y LEDs cada diez minutos con el iPhone bloqueado
  o la app suspendida. Un iPhone completamente apagado no puede hacerlo.
- Si el usuario fuerza el cierre de la app, desactiva Bluetooth o impide la
  actualización en segundo plano, la continuidad puede interrumpirse.

## Estado de validación

Compila para iOS Simulator y Mac Catalyst con Xcode. Falta comprobar la conexión
con cada modelo físico y el funcionamiento prolongado con el dispositivo en
reposo. Antes de distribuir públicamente hay que resolver los derechos de los
datos bursátiles, además de la firma, privacidad y ficha de la tienda.
