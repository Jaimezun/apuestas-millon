# El Millón

Una competencia de apuestas con dinero de mentira: todos empiezan con
**$1,000,000** y gana quien termine con más.

## Cómo se juega

Para entrar solo se escribe un nombre. Hay tres juegos:

| Juego | Opciones | Si ganas | Si pierdes |
|---|---|---|---|
| Moneda | águila o sol | conservas tu apuesta y ganas 0.9 veces más | pierdes lo apostado |
| Caballos | 4 caballos | conservas tu apuesta y ganas 2.7 veces más | pierdes lo apostado |
| Copas | 3 copas, una piedrita | conservas tu apuesta y ganas 1.8 veces más | pierdes lo apostado |

La página muestra en tiempo real la tabla de posiciones (saldo y cuánto ha
ganado o perdido cada jugador), la ganancia neta de la casa, lo que han ganado
o perdido los jugadores en conjunto y las últimas jugadas.

## Cómo está hecho

- `index.html`, `estilos.css`, `app.js`, `config.js`: página estática, sin
  build. La publica GitHub Pages desde la rama `main`.
- `supabase/migrations/`: el esquema del proyecto de Supabase.

El navegador nunca decide un resultado ni toca un saldo. Solo lee las tablas
(`jugadores`, `apuestas`, `casa_juegos`) y llama dos funciones:

- `crear_jugador(nombre)` da de alta al jugador y regresa una llave secreta
  que se guarda en el navegador (`localStorage`). Sin esa llave nadie puede
  apostar a nombre de otro; por lo mismo, el jugador vive en el navegador
  donde se creó.
- `apostar(jugador, llave, juego, elección, monto)` valida el saldo, sortea el
  resultado, mueve el dinero y lo deja escrito, todo en una transacción.

El sorteo (`azar(n)`) usa bytes criptográficos de `pgcrypto`
(`gen_random_bytes`) con muestreo por rechazo, así que cada opción tiene
exactamente la misma probabilidad: 1/2 en la moneda, 1/4 en los caballos y 1/3
en las copas. Las animaciones solo muestran lo que el servidor ya sorteó; en
las copas, estas se juntan y se separan en otro orden para que no haya nada
que seguir con la vista.

## Desplegar un cambio de esquema

```sh
supabase db push --remote=<ref-del-proyecto> --password <contraseña> --dry-run
supabase db push --remote=<ref-del-proyecto> --password <contraseña>
```

## Probar en local

Cualquier servidor estático sirve, por ejemplo `npx serve .` y abrir la URL.
