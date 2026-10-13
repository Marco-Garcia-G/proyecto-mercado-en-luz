# Android · versión de desarrollo

Esta app reutiliza la interfaz de la web, pero la cartera se guarda en el móvil y
el control de modelos Govee compatibles se hace por Bluetooth desde Android. El Mac no
interviene. La app usa un servicio visible para continuar consultando precios y
actualizando la tira cuando se cierra la pantalla.

## Abrir en Android Studio

1. Instala Android Studio y, desde su asistente, el SDK de Android 35.
2. Abre **esta carpeta `android`** como proyecto, no la carpeta `web`.
3. Conecta un Android con Bluetooth y depuración USB activada; ejecuta la
   configuración `app` desde Android Studio.
4. Concede el permiso de dispositivos cercanos. Acerca el móvil a la tira y
   cierra antes el programa del Mac o la app Govee para evitar que ocupen la tira.
5. En Android 13 o posterior, concede también las notificaciones para ver el
   estado del servicio. La notificación permite detener las actualizaciones;
   al volver a abrir la app se inician de nuevo.

Al iniciarse, la app busca un anuncio Bluetooth del modelo seleccionado, recuerda
su dirección Android y consulta el estado. Puedes cambiar el modelo bajo el botón
de encendido: H617A es el predeterminado; H617C, H6053, H6072, H6102 y H6199
figuran como beta hasta probarlos con hardware real. Todos usan el mismo protocolo
segmentado. La dirección UUID de macOS del
`config.json` no se usa ni se ha copiado a Android.

## Qué está terminado y qué no

- Incluye los comandos de encendido, consulta de estado, brillo y colores
  segmentados; el protocolo tiene una prueba independiente de Android.
- La cartera inicial reproduce las nueve empresas y los segmentos del proyecto
  actual. Los cambios del editor y las tres carteras guardadas se almacenan localmente
  en el teléfono. No se sincronizan con otros dispositivos.
- Cotizaciones, búsqueda e histórico pasan por `QuoteSource`, para cambiar de
  proveedor sin rehacer la app. `YahooPrototypeQuotes` es solo una fuente
  provisional para desarrollo privado: puede bloquear peticiones y no es una
  solución autorizada para publicar una app de pago.
- Dividendos y resultados todavía aparecen como **no disponibles** en Android;
  no se inventan eventos. La web original del Mac conserva su funcionamiento.
- La app tiene icono adaptativo propio, incluida una versión monocroma para
  los temas de Android.
- Las consultas y el Bluetooth viven en un servicio de dispositivo conectado,
  independiente de la pantalla. El servicio mantiene una notificación y un
  bloqueo parcial de CPU mientras funciona, por lo que consume más batería.
- La interfaz ya se ha instalado y abierto en un Galaxy S23; la conexión real
  con la H617A y la actualización con la pantalla bloqueada siguen pendientes
  de comprobar en un dispositivo físico.
- «Destellos» es opcional y está desactivado de inicio. Si una
  cotización cruza por primera vez ±1…5 % durante la sesión, su tramo parpadea
  durante 1…5 segundos. Cada empresa, dirección y umbral se señala como máximo
  una vez por sesión. Al abrir la app a mitad de sesión, la primera lectura es
  la referencia y no desencadena destellos antiguos. No hay cobro integrado.
- Los destellos dependen de nuevas cotizaciones y del enlace Bluetooth. El
  servicio sigue activo con la pantalla apagada, pero Android o el fabricante
  pueden aplazar la red en reposo profundo o detener el proceso: no se promete
  una lectura exactamente cada diez minutos. Con el teléfono completamente
  apagado no puede funcionar ninguna app.

Antes de publicar: probar en el móvil real una sesión larga con pantalla
bloqueada y reconexiones Bluetooth/red, medir consumo de batería, contratar o
confirmar derechos de la fuente bursátil, y completar firma de publicación,
política de privacidad y ficha de la tienda. La fuente actual de cotizaciones
es provisional y no debe distribuirse como producto de pago.
