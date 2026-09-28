// Loaded by index.html: its exports are runtime entry symbols.
function drawSheet() {
  return sheetSize();
}

// Called by drawSheet: alive.
function sheetSize() {
  return 1;
}

// Nothing calls it: private_dead.
function rendererDead() {
  return 0;
}

module.exports = { drawSheet };
