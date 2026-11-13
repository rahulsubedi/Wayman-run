// Fakes 40 frames of boost flight (with magnet) through the view modules only (no sim change).
(() => {
  const st = game.sim.state;
  const p = { ...st.player, action: 'fly', y: 7, vy: 0, grounded: false, speed: 28 };
  const f = { ...st, player: p, powerups: { ...st.powerups, boost: 5, magnet: 3 } };
  for (let i = 0; i < 40; i++) {
    p.s += p.speed / 30;
    p.runPhase += 0.6;
    game.scenery.update(p.s, game.forceZone ?? st.zone, 0, 1 / 30);
    game.fx.update(f, 1 / 30);
    game.cameraRig.update(p, 1 / 30);
    game.hero.update(p, f.powerups, 1 / 30);
    game.hero.node.position.z = game.stage.worldZ(p.s);
  }
  return game.fx.particleCount;
})()
