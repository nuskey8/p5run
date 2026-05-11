function setup() {
  createCanvas(windowWidth, windowHeight);
}

function draw() {
  background(200);
  const x = windowWidth / 2;
  const y = windowHeight / 2;
  circle(x, y, 300);
  rect(x, y, 200, 200);
}
