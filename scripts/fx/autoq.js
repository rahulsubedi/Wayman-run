// Exercises the frame-time watchdog: slow frames step the tier down; render() makes it inert.
(() => {
  const s = game.stage;
  const log = [s.quality];
  s.enableAutoQuality();
  for (let i = 0; i < 220; i++) s.sampleFrameTime(50); // 20 fps
  log.push(s.quality);
  s.enableAutoQuality();
  for (let i = 0; i < 100; i++) s.sampleFrameTime(50);
  s.render(); // debug path: must freeze it
  for (let i = 0; i < 400; i++) s.sampleFrameTime(50);
  log.push(s.quality, s.autoQualityEnabled);
  return log;
})()
