// Ticks the game (no rendering) until the run ends, then returns the sim time.
(() => {
  const st = game.sim.state;
  for (let i = 0; i < 30 * 60 && !st.over; i++) game.tick(1 / 30);
  return st.time;
})()
