// Times 60 game ticks (no rendering) and 3 renders including GPU completion (gl.finish).
(() => {
  let t0 = performance.now();
  for (let i = 0; i < 60; i++) game.tick(1 / 30);
  const tick = (performance.now() - t0) / 60;
  const gl = game.stage.app.renderer.gl;
  if (gl) gl.finish();
  t0 = performance.now();
  for (let i = 0; i < 3; i++) {
    game.stage.render();
    if (gl) gl.finish();
  }
  const render = (performance.now() - t0) / 3;
  return { tick, render, particles: game.fx.particleCount, q: game.stage.quality };
})()
