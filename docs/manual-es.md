# Manual de uso · Mercado en luz

## Apps móviles

La app [Android](../android/README.md) y el proyecto [iPhone, iPad y Mac](../ios/README.md)
reutilizan la misma interfaz. Cada instalación guarda su propia cartera y sus
ajustes. En las apps nativas puedes elegir H617A o cinco modelos adicionales en
beta: H617C, H6053, H6072, H6102 y H6199. La compatibilidad depende del
protocolo Bluetooth segmentado del modelo; hace falta comprobar cada tira real.
Las apps intentan renovar cotizaciones cada diez minutos, sujetos a las
restricciones de segundo plano del sistema.

La fuente de cotizaciones incluida es provisional para desarrollo privado. No
constituye un servicio de mercado autorizado para distribuir la app públicamente.
Todas las funciones (destellos, media de cartera, ambiente, carrusel, objetivos
y tres carteras guardadas) están incluidas y se configuran desde la sección
**Funciones**.

## Página web local

Abre la carpeta `app` del proyecto en el terminal y ejecuta:

```bash
python3 web_server.py
```

La página se abrirá automáticamente en este Mac. Si no aparece, entra en
`http://127.0.0.1:8765`. Desliza hasta el botón central para encender o apagar
la tira y baja un poco más para ver la cartera; pulsa una empresa para abrir
su gráfico interactivo. Mantén abierto el terminal mientras
uses la página. Al pulsar **Control + C**, el servidor se cierra y apaga la tira.

Para abrirla también en el móvil, conecta el móvil y el Mac a la misma Wi-Fi
y arranca el programa así:

```bash
python3 web_server.py --lan
```

El terminal mostrará una dirección `http://...:8765` para introducir en Safari
o Chrome del móvil. Si macOS pide permiso para conexiones entrantes, acéptalo.
Usa este modo solo en una red de confianza: cualquier dispositivo de esa red
que tenga la dirección podrá controlar la tira. Si ya estaba abierto, ciérralo
con **Control + C** antes de arrancarlo con `--lan`.

Al terminar la animación inicial, la tira de puntos queda debajo del botón.
Pasa el cursor sobre un segmento (o tócalo en una pantalla táctil) para ver
su empresa, variación y color; los segmentos de esa empresa se resaltan juntos.
Con la tira física apagada, sus colores aparecen atenuados en la página, pero
la consulta de la cartera sigue disponible.

Para cambiar la cartera, pulsa **Editar cartera**. Elige una de las cuatro
empresas sugeridas o busca por nombre o símbolo. Selecciona una empresa y toca
los segmentos que quieras asignarle; en el ordenador también puedes arrastrar
su fila. En móvil, desliza la tira horizontalmente para llegar a los segmentos
del final. Si los 15 ya están ocupados, puedes añadir otra empresa y darle un
segmento que otra tenga de sobra. No podrás guardar hasta que cada empresa tenga
al menos uno. Puedes quitar empresas desde `···` y deshacer la última retirada
durante unos segundos. Los cambios solo se aplican al
pulsar **Guardar cambios** y se conservan en `config.json` para la próxima vez.
Por ahora, la búsqueda incluye acciones de las bolsas de EE. UU. y Madrid y
el servidor web local del Mac sigue preparado para la Govee H617A. La selección
de otros modelos está disponible en las apps nativas.

En el gráfico puedes elegir 1 día, 1 mes, 6 meses, 1 año o 5 años. Abre
«Herramientas» para mostrar «Media 200», «Dividendos» y «Dibujar». «Media 200»
traza el promedio de los últimos 200 cierres diarios y solo está disponible
en periodos de varios días. Mueve el cursor sobre la curva para ver precio y
fecha; haz clic o toca para fijar un punto y usa las flechas para recorrerlo.
Con «Dibujar» arrastras para crear un rectángulo; luego puedes moverlo,
cambiar su tamaño desde las esquinas, duplicarlo o eliminarlo. Los dibujos se
guardan solo en este navegador, separados por empresa y periodo.

Al cambiar de periodo, el gráfico hace una transición breve y mantiene señalado
el punto más cercano al que estabas examinando. Los resultados publicados se
señalan con un rombo discreto. «Dividendos» muestra u oculta puntos naranjas:
al pasar sobre uno verás únicamente el porcentaje de ese pago respecto al cierre
anterior. Si no hay puntos en el periodo elegido, la página lo indica y permite
abrir cinco años. Bajo el gráfico se muestra el último porcentaje conocido o
una estimación del próximo, cuando hay datos; no es una promesa de rentabilidad.
El detalle de cada empresa se abre directamente a pantalla completa.

Las pruebas automáticas sin conexión Bluetooth se ejecutan con
`python3 -m unittest discover -s tests -v`.

### Conexión Bluetooth

No hace falta configurar ninguna dirección: la primera vez, el Mac busca durante
unos segundos las tiras cercanas del modelo indicado en `config.json` (`model`,
por defecto `H617A`) y se queda con la de mejor señal. Funciona con cualquier
H617A, no solo con una concreta. La tira elegida se recuerda en `device.json`
(identificador propio de cada Mac); si deja de aparecer, se olvida y se vuelve a
buscar. Con varias tiras en casa, **Cambiar de tira** fuerza una nueva búsqueda.

Bajo el botón de encendido, un indicador muestra en todo momento la fase:
*Buscando tiras…*, *Conectando con H617A · 5D33…*, *Comprobando el estado…*,
*Conectada* o *Sin conexión* con la cuenta atrás del siguiente reintento
automático. Si algo falla, el aviso explica la causa (Bluetooth apagado, falta
de permiso, tira no encontrada, tira ocupada por otro dispositivo…) y qué hacer,
con **Reintentar ahora** y **Buscar otra tira**.

macOS solo permite usar Bluetooth a la app desde la que se ejecuta el servidor
(Terminal o VS Code): la primera vez pedirá permiso. Si lo deniegas, actívalo en
Ajustes del Sistema › Privacidad y seguridad › Bluetooth.

El botón de encendido/apagado consulta el estado Bluetooth real después de
enviar la orden. Si no puede confirmarlo, mostrará un aviso en vez de afirmar
que la tira cambió de estado. Si ya tenías el servidor abierto al actualizar
estos archivos, deténlo con **Control + C** y vuelve a ejecutar el comando.

Las cotizaciones del servidor web local se consultan según los intervalos de
`config.json`, con una fuente provisional de Yahoo Finance; pueden llegar con
retraso y no equivalen a un servicio
bursátil en tiempo real garantizado. Sin `--lan`, la página solo escucha conexiones
en este Mac. No ejecutes a la vez el monitor de terminal y la página, porque los dos
intentarían controlar la misma tira por Bluetooth.

## Monitor de terminal (sin página)

Si prefieres usar la versión anterior sin navegador, ejecuta:

```bash
python3 market_govee.py
```

Ambas versiones necesitan Bluetooth e internet. Se detienen con **Control + C**.

## Configuración

Puedes editar `config.json` con el programa detenido:

- `model`: modelo de tira que se busca por Bluetooth (por defecto `H617A`).
- `portfolio`: empresas, símbolo bursátil, mercado (`ES` o `US`) y segmentos de la tira (del 0 al 14).
- `brightness`: brillo global de la tira (1 a 100).
- `colors`: rojo y verde en formato hexadecimal `#RRGGBB`; `sin datos` apaga los segmentos sin cotización.
- `open_interval_seconds`: espera entre consultas durante el horario habitual de alguna de las bolsas. Por defecto, 300 segundos.
- `closed_interval_seconds`: espera fuera de ese horario. Por defecto, 1800 segundos. El programa también consulta justo al llegar la próxima apertura habitual.
- `ble_retry_seconds`: esperas sucesivas tras un fallo Bluetooth. La última se repite hasta conseguir conectar.

El color representa la variación del último precio frente al cierre de la sesión anterior:

| Variación | Color | Código actual |
| --- | --- | --- |
| Negativa | Rojo | `#FF0000` |
| Cero o positiva | Verde | `#00FF00` |

El brillo global permanece al 100 %. El código `sin datos` es `#000000`, que apaga el segmento cuando aún no hay ningún precio válido. El programa comprueba `config.json` cada 10 segundos y aplica los cambios de color a los segmentos activos. Muestra los códigos cargados en el terminal. Si el programa ya estaba abierto antes de incorporar esta función, reinícialo una vez.

Si falla la consulta de una empresa, se conserva su último dato válido mientras siga abierto el programa. Si todavía no hay ninguno, su segmento queda apagado. Fuera de horario, la tira conserva los últimos colores y solo se envía algo por Bluetooth si los colores cambian o el ordenador vuelve de una suspensión.

Los horarios `ES` y `US` son los habituales de Madrid y Nueva York. El programa tiene en cuenta la zona horaria y el horario de verano, pero no consulta un calendario de festivos ni cierres especiales. En esos días puede consultar más a menudo de lo necesario; no cambiará la tira si el resultado sigue siendo el mismo.
