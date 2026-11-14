// Three-Live spatial & camera verification scene for the InBudget 3-island lodge stage.
// Validate: three-live-cli validate scenes/shortlist-stage.three.js --json
// Render:   three-live-cli render scenes/shortlist-stage.three.js -o assets/stage-quad.png --view=quad --grid
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10211b);

const camera = new THREE.PerspectiveCamera(40, 16 / 10, 0.1, 90);
camera.position.set(0.2, 5.8, 12.8);
camera.lookAt(0, 0.9, 0);

const hemi = new THREE.HemisphereLight(0xdce9ff, 0x3b2f20, 0.9);
const sun = new THREE.DirectionalLight(0xffd79e, 2.4);
sun.position.set(7, 11, 8);
scene.add(hemi, sun);

function createIslandDiorama(name, x, z, scale, roofHex, wallHex, height) {
  const group = new THREE.Group();
  group.name = name;
  group.position.set(x, 0, z);
  group.scale.setScalar(scale);

  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(2.95, 2.65, 0.44, 48),
    new THREE.MeshStandardMaterial({ color: 0x3f563d, roughness: 0.88 })
  );
  plinth.position.y = 0.22;
  group.add(plinth);

  const brassRim = new THREE.Mesh(
    new THREE.TorusGeometry(2.96, 0.045, 12, 64),
    new THREE.MeshStandardMaterial({ color: 0xc8a96e, metalness: 0.85, roughness: 0.24 })
  );
  brassRim.rotation.x = Math.PI / 2;
  brassRim.position.y = 0.43;
  group.add(brassRim);

  const cabinBody = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, height, 2.2),
    new THREE.MeshStandardMaterial({ color: wallHex, roughness: 0.72 })
  );
  cabinBody.position.set(0, 0.44 + height / 2, -0.15);
  group.add(cabinBody);

  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(1.95, 1.15, 4),
    new THREE.MeshStandardMaterial({ color: roofHex, metalness: 0.35, roughness: 0.45 })
  );
  roof.rotation.y = Math.PI / 4;
  roof.position.set(0, 0.44 + height + 0.55, -0.15);
  group.add(roof);

  const windowGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(0.65, 0.48),
    new THREE.MeshStandardMaterial({ color: 0xffcf86, emissive: 0xffa83e, emissiveIntensity: 1.6 })
  );
  windowGlow.position.set(0, 0.44 + height * 0.48, 0.96);
  group.add(windowGlow);

  return group;
}

scene.add(
  createIslandDiorama('FernHollowCabin', 0, 0.85, 1.0, 0x2c3639, 0x8f3a2f, 1.45),
  createIslandDiorama('RidgeHouse', -4.55, -0.35, 0.76, 0x262f33, 0x9e3b31, 1.75),
  createIslandDiorama('TheLaurelLodge', 4.55, -0.35, 0.76, 0x454a4d, 0xd8d0be, 2.05)
);
