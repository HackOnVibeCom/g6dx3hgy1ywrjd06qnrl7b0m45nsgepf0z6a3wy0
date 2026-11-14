import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const assetBase = new URL('./assets/models/', import.meta.url);
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

const STAYS = [
  {
    file: 'fern-hollow-cabin.glb',
    size: 2.95,
    shadowRadius: 1.95,
    turn: 0.36,
    at: [0.05, 0, -0.18],
    porchGlow: [0.12, 0.95],
    spruces: [[-2.15, -1.45, 2.55], [-1.05, -2.35, 3.05], [0.55, -2.5, 2.7], [1.95, -1.9, 3.15], [2.45, -0.55, 2.25]],
    rocks: [[-2.05, 0.95, 0.85, 0.4], [2.1, 0.85, 0.78, 2.1]],
    ferns: [[-1.65, -0.65, 0.72], [1.65, -0.85, 0.68], [-2.15, -0.35, 0.62]],
    campfire: [1.28, 1.72],
    lanterns: [[-0.58, 1.55], [0.62, 1.48]],
  },
  {
    file: 'ridge-house.glb',
    size: 3.7,
    shadowRadius: 2.35,
    turn: -0.32,
    at: [0, 0, -0.22],
    porchGlow: [-0.1, 1.08],
    spruces: [[-2.35, -1.35, 2.85], [-1.1, -2.45, 2.6], [1.2, -2.45, 3.1], [2.35, -1.3, 2.75]],
    rocks: [[-2.15, 0.85, 0.9, 1.5], [2.0, 1.25, 0.76, 0.6]],
    ferns: [[-1.85, -0.45, 0.7], [1.85, -0.55, 0.74]],
    campfire: null,
    lanterns: [[-0.72, 1.62], [0.68, 1.62]],
  },
  {
    file: 'laurel-lodge.glb',
    size: 4.15,
    shadowRadius: 2.55,
    turn: 0.28,
    at: [0, 0, -0.28],
    porchGlow: [0.15, 1.12],
    spruces: [[-2.45, -1.15, 2.75], [-1.35, -2.45, 3.2], [0.25, -2.65, 2.65], [1.85, -2.15, 3.05]],
    rocks: [[-2.15, 1.05, 0.88, 0.9], [2.15, 0.95, 0.82, 2.4]],
    ferns: [[-1.95, -0.35, 0.72], [1.95, -0.4, 0.68]],
    campfire: [1.35, 1.78],
    lanterns: [[-0.82, 1.58], [0.82, 1.58]],
  },
];

function normalizeModel(source, targetFootprint, byHeight = false) {
  const cloned = source.clone(true);
  const box = new THREE.Box3().setFromObject(cloned);
  const size = box.getSize(new THREE.Vector3());
  const holder = new THREE.Group();
  cloned.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  holder.add(cloned);
  const basis = byHeight ? Math.max(size.y, 0.001) : Math.max(size.x, size.z, 0.001);
  holder.scale.setScalar(targetFootprint / basis);
  return holder;
}

function prepareGltf(scene) {
  scene.traverse(node => {
    if (!node.isMesh) return;
    for (const mat of [node.material].flat()) {
      if (!mat) continue;
      if (mat.map) mat.map.anisotropy = 4;
      if (/glass|window|pane/i.test(mat.name || '') || (mat.transmission && mat.transmission > 0.1)) {
        mat.transmission = 0;
        mat.emissive = new THREE.Color('#ffb357');
        mat.emissiveIntensity = 0.78;
      }
    }
  });
  return scene;
}

const discGeom = (() => {
  const g = new THREE.CircleGeometry(1, 24);
  g.rotateX(-Math.PI / 2);
  return g;
})();

const contactShadowMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv * 2.0 - 1.0;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    varying vec2 vUv;
    void main() {
      float d = clamp(1.0 - length(vUv), 0.0, 1.0);
      gl_FragColor = vec4(0.03, 0.07, 0.05, pow(d, 1.75) * 0.56);
    }
  `,
});

function createContactShadow(radius, x, z) {
  const mesh = new THREE.Mesh(discGeom, contactShadowMat);
  mesh.scale.setScalar(radius);
  mesh.position.set(x, 0.008, z);
  return mesh;
}

function createWarmPool(colorHex, radius, opacity) {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(colorHex) },
      uStrength: { value: opacity },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec2 vUv;
      void main() {
        float d = clamp(1.0 - length(vUv), 0.0, 1.0);
        gl_FragColor = vec4(uColor, pow(d, 2.2) * uStrength);
      }
    `,
  });
  const mesh = new THREE.Mesh(discGeom, mat);
  mesh.scale.setScalar(radius);
  mesh.position.y = 0.018;
  return { mesh, uniforms: mat.uniforms };
}

function createSharedIslandAssets(grassMap) {
  return {
    plinthGeo: new THREE.CylinderGeometry(3.08, 2.74, 0.52, 56, 1),
    rimGeo: new THREE.TorusGeometry(3.09, 0.042, 12, 72),
    lowerRimGeo: new THREE.TorusGeometry(2.76, 0.028, 10, 56),
    paverGeo: new THREE.CylinderGeometry(0.22, 0.25, 0.042, 7),
    haloGeo: new THREE.RingGeometry(2.85, 3.82, 56),
    topMat: new THREE.MeshStandardMaterial({
      map: grassMap,
      normalScale: new THREE.Vector2(0.8, 0.8),
      roughness: 0.9,
      metalness: 0.02,
      color: '#bdd0a4',
    }),
    sideMat: new THREE.MeshStandardMaterial({
      normalScale: new THREE.Vector2(1.0, 1.0),
      roughness: 0.94,
      metalness: 0.05,
      color: '#5a5346',
    }),
    bottomMat: new THREE.MeshStandardMaterial({ color: '#1b2820', roughness: 0.95 }),
    brassMat: new THREE.MeshStandardMaterial({
      color: '#d4b475',
      metalness: 0.88,
      roughness: 0.24,
      envMapIntensity: 1.3,
    }),
    lowerRimMat: new THREE.MeshStandardMaterial({ color: '#5a6e58', metalness: 0.55, roughness: 0.42 }),
    stoneMat: new THREE.MeshStandardMaterial({ color: '#9ca395', roughness: 0.82, metalness: 0.06 }),
    bulbGeo: new THREE.SphereGeometry(0.048, 8, 8),
    bulbMat: new THREE.MeshBasicMaterial({ color: '#ffd98e' }),
  };
}

function createIsland(shared, haloUniforms) {
  const group = new THREE.Group();

  const plinth = new THREE.Mesh(shared.plinthGeo, [shared.sideMat, shared.topMat, shared.bottomMat]);
  plinth.position.y = -0.26;
  group.add(plinth);

  const brassRim = new THREE.Mesh(shared.rimGeo, shared.brassMat);
  brassRim.rotation.x = Math.PI / 2;
  brassRim.position.y = -0.015;
  group.add(brassRim);

  const lowerRim = new THREE.Mesh(shared.lowerRimGeo, shared.lowerRimMat);
  lowerRim.rotation.x = Math.PI / 2;
  lowerRim.position.y = -0.49;
  group.add(lowerRim);

  for (let s = 0; s < 4; s++) {
    const paver = new THREE.Mesh(shared.paverGeo, shared.stoneMat);
    paver.scale.set(1.35 - s * 0.05, 1, 0.82);
    paver.position.set(Math.sin(s * 0.9) * 0.14, 0.012, 1.32 + s * 0.36);
    paver.rotation.y = s * 0.55;
    group.add(paver);
  }

  const halo = new THREE.Mesh(
    shared.haloGeo,
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: haloUniforms,
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uHaloColor;
        uniform float uHaloStrength;
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          float radial = sin(clamp(vUv.y, 0.0, 1.0) * 3.14159265);
          float shimmer = 0.88 + 0.12 * sin(vUv.x * 37.699 + uTime * 1.6);
          float alpha = pow(radial, 1.85) * uHaloStrength * shimmer;
          gl_FragColor = vec4(uHaloColor, alpha);
        }
      `,
    })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = -0.5;
  group.add(halo);

  return group;
}

function createFireflies() {
  const count = 44;
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 * 3.7;
    const radius = 1.4 + (i % 9) * 0.72;
    positions[i * 3] = Math.cos(angle) * radius * 1.3;
    positions[i * 3 + 1] = 0.35 + ((i * 17) % 23) * 0.12;
    positions[i * 3 + 2] = Math.sin(angle) * radius * 0.7;
    seeds[i * 3] = (i * 0.73) % 6.283;
    seeds[i * 3 + 1] = 0.55 + (i % 5) * 0.22;
    seeds[i * 3 + 2] = i % 3 === 0 ? 1.0 : 0.55;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));

  const uniforms = {
    uTime: { value: 0 },
    uPixelRatio: { value: 1 },
    uOpacity: { value: 0.85 },
  };

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms,
    vertexShader: `
      attribute vec3 aSeed;
      uniform float uTime;
      uniform float uPixelRatio;
      varying float vTwinkle;
      varying float vWarm;
      void main() {
        vec3 pos = position;
        float t = uTime * aSeed.y + aSeed.x;
        pos.x += sin(t * 0.9) * 0.26;
        pos.y += sin(t * 1.3 + aSeed.x) * 0.2;
        pos.z += cos(t * 0.8) * 0.22;
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mv;
        vTwinkle = 0.45 + 0.55 * sin(t * 2.4 + aSeed.x * 3.0);
        vWarm = aSeed.z;
        gl_PointSize = clamp((22.0 + 16.0 * aSeed.z) * uPixelRatio / max(1.0, -mv.z), 2.0, 12.0);
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      varying float vTwinkle;
      varying float vWarm;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float soft = pow(1.0 - d * 2.0, 2.2);
        vec3 col = mix(vec3(0.82, 0.93, 0.58), vec3(1.0, 0.78, 0.42), vWarm);
        gl_FragColor = vec4(col, soft * vTwinkle * uOpacity * 0.78);
      }
    `,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return { points, uniforms };
}

const flameGeom = new THREE.PlaneGeometry(0.4, 0.46);

function createEmberFlame() {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uGain: { value: 1 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uGain;
      varying vec2 vUv;
      void main() {
        vec2 p = vUv - vec2(0.5, 0.18);
        p.x *= 1.8 + 0.25 * sin(uTime * 7.0 + vUv.y * 8.0);
        float core = max(0.0, 1.0 - length(vec2(p.x, p.y * 0.85)) * 2.3);
        float flicker = 0.82 + 0.18 * sin(uTime * 11.0 + vUv.y * 5.0);
        vec3 col = mix(vec3(1.0, 0.34, 0.06), vec3(1.0, 0.86, 0.42), pow(core, 1.6));
        gl_FragColor = vec4(col, pow(core, 1.7) * flicker * uGain * 0.92);
      }
    `,
  });
  const group = new THREE.Group();
  for (let k = 0; k < 2; k++) {
    const plane = new THREE.Mesh(flameGeom, mat);
    plane.position.y = 0.21;
    plane.rotation.y = (k * Math.PI) / 2;
    group.add(plane);
  }
  return { group, uniforms: mat.uniforms };
}

function captureTintables(root) {
  const list = [];
  const clonedMats = new Map();
  root.traverse(node => {
    if (!node.isMesh) return;
    const swap = mat => {
      if (!mat || !mat.color) return mat;
      if (!clonedMats.has(mat)) {
        const c = mat.clone();
        const base = c.color.clone();
        const luma = base.r * 0.26 + base.g * 0.56 + base.b * 0.18;
        const muted = new THREE.Color(luma * 0.72, luma * 0.78, luma * 0.82);
        clonedMats.set(mat, { mat: c, base, muted });
        list.push(clonedMats.get(mat));
      }
      return clonedMats.get(mat).mat;
    };
    node.material = Array.isArray(node.material) ? node.material.map(swap) : swap(node.material);
  });
  return list;
}

export async function createScene(canvas, onUpdate) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
  });

  let disposed = false;

  try {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.22;
    renderer.setClearColor(0x000000, 0);

    await MeshoptDecoder.ready;

    const ktx2 = new KTX2Loader()
      .setTranscoderPath(new URL('./vendor/three/addons/libs/basis/', import.meta.url).href)
      .setWorkerLimit(2)
      .detectSupport(renderer);

    const gltfLoader = new GLTFLoader()
      .setKTX2Loader(ktx2)
      .setMeshoptDecoder(MeshoptDecoder);

    const loadGlb = file =>
      gltfLoader.loadAsync(new URL(file, assetBase).href).then(res => prepareGltf(res.scene));

    const texLoader = new THREE.TextureLoader();
    const loadRepeated = (file, repeat, isColor) =>
      texLoader.loadAsync(new URL(file, assetBase).href).then(map => {
        map.wrapS = map.wrapT = THREE.RepeatWrapping;
        map.repeat.set(...repeat);
        map.anisotropy = 4;
        if (isColor) map.colorSpace = THREE.SRGBColorSpace;
        return map;
      });

    // Stage 1: Load ONLY the primary hero cabin + spruce + grass (~385 KB) for instant first frame
    const [fernCabin, spruceModel, grass] = await Promise.all([
      loadGlb(STAYS[0].file),
      loadGlb('spruce.glb'),
      loadRepeated('grass-color.webp', [2.8, 2.8], true),
    ]);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.78;

    const hemi = new THREE.HemisphereLight('#cfe3ff', '#3c2e1f', 1.15);
    const sun = new THREE.DirectionalLight('#ffd59a', 2.75);
    sun.position.set(7.5, 11.5, 8.5);
    const rimLight = new THREE.DirectionalLight('#8ec5b6', 1.05);
    rimLight.position.set(-8.5, 5.5, -7.5);
    scene.add(hemi, sun, rimLight);

    const shared = createSharedIslandAssets(grass);
    const flameUniformList = [];

    const attachHouse = (group, spec, model) => {
      const house = normalizeModel(model, spec.size, false);
      house.position.set(...spec.at);
      house.rotation.y = spec.turn;
      const shadow = createContactShadow(spec.shadowRadius, spec.at[0], spec.at[2]);
      group.add(shadow, house);
      group.userData.tintables = captureTintables(house);
      if (Math.abs(group.userData.lastTone - 1) > 0.01) {
        for (const entry of group.userData.tintables) {
          entry.mat.color.copy(entry.muted).lerp(entry.base, group.userData.lastTone);
        }
      }
    };

    const groups = STAYS.map((spec, idx) => {
      const haloUniforms = {
        uHaloColor: { value: new THREE.Color('#d4b475') },
        uHaloStrength: { value: 0.35 },
        uTime: { value: 0 },
      };
      const group = createIsland(shared, haloUniforms);

      const porchPool = createWarmPool('#ffad4c', 1.35, 0.34);
      porchPool.mesh.position.set(spec.porchGlow[0], 0.018, spec.porchGlow[1]);
      group.add(porchPool.mesh);

      for (const [x, z, h] of spec.spruces) {
        const tree = normalizeModel(spruceModel, h, true);
        tree.position.set(x, -0.02, z);
        tree.rotation.y = x * 1.9 + z * 1.3;
        group.add(createContactShadow(h * 0.28, x, z), tree);
      }

      group.userData = {
        tintables: [],
        lastTone: 1,
        haloUniforms,
        porchPool,
        firePool: null,
        flameUniforms: null,
      };

      if (idx === 0) attachHouse(group, spec, fernCabin);
      scene.add(group);
      return group;
    });

    const fireflies = createFireflies();
    scene.add(fireflies.points);

    const camera = new THREE.PerspectiveCamera(42, 1.5, 0.1, 95);
    camera.position.set(0.14, 3.65, 9.2);
    camera.lookAt(0, 0.95, 1.05);

    if (typeof renderer.compileAsync === 'function') {
      await renderer.compileAsync(scene, camera);
    } else {
      renderer.compile(scene, camera);
    }

    const precompile = async obj => {
      if (typeof renderer.compileAsync === 'function') {
        try { await renderer.compileAsync(obj, camera, scene); } catch {}
      }
    };

    // Stage 2: Stream secondary cabins, props, normal maps & sky HDRI across idle frames without blocking
    (async () => {
      try {
        await nextFrame();
        if (disposed) return;
        const [ridgeCabin, laurelCabin] = await Promise.all([
          loadGlb(STAYS[1].file),
          loadGlb(STAYS[2].file),
        ]);
        if (disposed) return;
        await Promise.all([precompile(ridgeCabin), precompile(laurelCabin)]);
        if (disposed) return;
        attachHouse(groups[1], STAYS[1], ridgeCabin);
        attachHouse(groups[2], STAYS[2], laurelCabin);
        onUpdate?.();

        await nextFrame();
        if (disposed) return;
        const [campfireModel, lanternModel, rocksModel, fernModel] = await Promise.all([
          loadGlb('campfire.glb'),
          loadGlb('lantern.glb'),
          loadGlb('mossy-rocks.glb'),
          loadGlb('bracken-fern.glb'),
        ]);
        if (disposed) return;
        await Promise.all([
          precompile(campfireModel),
          precompile(lanternModel),
          precompile(rocksModel),
          precompile(fernModel),
        ]);
        if (disposed) return;

        STAYS.forEach((spec, idx) => {
          const group = groups[idx];
          for (const [x, z, size, rot] of spec.rocks) {
            const rock = normalizeModel(rocksModel, size, false);
            rock.position.set(x, -0.03, z);
            rock.rotation.y = rot;
            group.add(rock);
          }
          for (const [x, z, size] of spec.ferns) {
            const fern = normalizeModel(fernModel, size, false);
            fern.position.set(x, -0.01, z);
            fern.rotation.y = x * 2.4 - z;
            group.add(fern);
          }
          for (const [lx, lz] of spec.lanterns) {
            const lantern = normalizeModel(lanternModel, 0.36, true);
            lantern.position.set(lx, 0.0, lz);
            const bulb = new THREE.Mesh(shared.bulbGeo, shared.bulbMat);
            bulb.position.set(lx, 0.16, lz);
            group.add(lantern, bulb);
          }
          if (spec.campfire) {
            const [fx, fz] = spec.campfire;
            const pit = normalizeModel(campfireModel, 0.86, false);
            pit.position.set(fx, 0.005, fz);
            const flame = createEmberFlame();
            flame.group.position.set(fx, 0.03, fz);
            const firePool = createWarmPool('#ff6f24', 0.95, 0.42);
            firePool.mesh.position.set(fx, 0.016, fz);
            group.add(pit, flame.group, firePool.mesh);
            group.userData.firePool = firePool;
            group.userData.flameUniforms = flame.uniforms;
            flameUniformList.push(flame.uniforms);
          }
        });
        ktx2.dispose();
        onUpdate?.();

        await nextFrame();
        if (disposed) return;
        const [grassNormal, soil, soilNormal, skyMap] = await Promise.all([
          loadRepeated('grass-normal.webp', [2.8, 2.8], false),
          loadRepeated('soil-color.webp', [7.0, 0.5], true),
          loadRepeated('soil-normal.webp', [7.0, 0.5], false),
          texLoader.loadAsync(new URL('golden-hour-sky.jpg', assetBase).href).catch(() => null),
        ]);
        if (disposed) return;
        shared.topMat.normalMap = grassNormal;
        shared.topMat.needsUpdate = true;
        shared.sideMat.map = soil;
        shared.sideMat.normalMap = soilNormal;
        shared.sideMat.color.set('#6e6454');
        shared.sideMat.needsUpdate = true;

        if (skyMap) {
          skyMap.mapping = THREE.EquirectangularReflectionMapping;
          skyMap.colorSpace = THREE.SRGBColorSpace;
          pmrem.compileEquirectangularShader();
          const oldEnv = scene.environment;
          scene.environment = pmrem.fromEquirectangular(skyMap).texture;
          scene.environmentIntensity = 0.86;
          oldEnv?.dispose();
          skyMap.dispose();
        }
        pmrem.dispose();
        onUpdate?.();
      } catch {
        ktx2.dispose();
        pmrem.dispose();
      }
    })();

    const coolSun = new THREE.Color('#c8dcff');
    const warmSun = new THREE.Color('#ffd394');
    const colorActive = new THREE.Color('#d8bf7c');
    const colorFit = new THREE.Color('#cbe879');
    const colorIdle = new THREE.Color('#51735e');
    const colorMuted = new THREE.Color('#3b4842');
    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    const pickSphere = new THREE.Sphere();
    const hitPoint = new THREE.Vector3();
    let lastW = 0;
    let lastH = 0;

    return {
      draw({ eye, target, aspect, zoom }, items, warmth, clockSeconds = 0, reducedMotion = false) {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (!w || !h) return;

        const ratio = Math.min(devicePixelRatio || 1, w < 650 ? 1.25 : 1.5);
        if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
        if (w !== lastW || h !== lastH) {
          lastW = w;
          lastH = h;
          renderer.setSize(w, h, false);
        }

        camera.fov = (2 * Math.atan(Math.tan(Math.PI / 7) / zoom) * 180) / Math.PI;
        camera.aspect = aspect;
        camera.position.set(...eye);
        camera.lookAt(...target);
        camera.updateProjectionMatrix();

        sun.color.copy(coolSun).lerp(warmSun, warmth);
        sun.intensity = 2.15 + warmth * 0.85;
        hemi.intensity = 1.15 - warmth * 0.18;

        const t = reducedMotion ? 0 : clockSeconds;
        fireflies.uniforms.uTime.value = t;
        fireflies.uniforms.uPixelRatio.value = ratio;
        fireflies.uniforms.uOpacity.value = reducedMotion ? 0.35 : 0.85;
        for (const fu of flameUniformList) fu.uTime.value = t;

        items.forEach(({ x, y, z, angle, scale, tone, primary, pass }, i) => {
          const group = groups[i];
          group.visible = scale >= 0.02;
          if (!group.visible) return;

          group.position.set(x, y, z);
          group.rotation.y = angle;
          group.scale.setScalar(Math.max(scale, 0.001));

          const data = group.userData;
          if (Math.abs(data.lastTone - tone) > 0.01) {
            data.lastTone = tone;
            for (const entry of data.tintables) {
              entry.mat.color.copy(entry.muted).lerp(entry.base, tone);
            }
          }

          const verdictBoost = pass === true ? 1.25 : pass === false ? 0.25 : 1.0;
          data.porchPool.uniforms.uStrength.value = (primary ? 0.38 : 0.18) * verdictBoost;
          if (data.firePool) {
            const flicker = reducedMotion ? 1 : 0.88 + 0.14 * Math.sin(t * 9.5 + i * 2.1);
            data.firePool.uniforms.uStrength.value = (primary ? 0.44 : 0.22) * verdictBoost * flicker;
            if (data.flameUniforms) data.flameUniforms.uGain.value = Math.min(1.2, verdictBoost);
          }

          data.haloUniforms.uTime.value = t;
          if (pass === true) {
            data.haloUniforms.uHaloColor.value.copy(colorFit);
            data.haloUniforms.uHaloStrength.value = primary ? 0.66 : 0.42;
          } else if (pass === false) {
            data.haloUniforms.uHaloColor.value.copy(colorMuted);
            data.haloUniforms.uHaloStrength.value = 0.08;
          } else if (primary) {
            data.haloUniforms.uHaloColor.value.copy(colorActive);
            data.haloUniforms.uHaloStrength.value = 0.46;
          } else {
            data.haloUniforms.uHaloColor.value.copy(colorIdle);
            data.haloUniforms.uHaloStrength.value = 0.16;
          }
        });

        renderer.render(scene, camera);
      },
      pick(ndcX, ndcY) {
        pointerNdc.set(ndcX, ndcY);
        raycaster.setFromCamera(pointerNdc, camera);
        let bestIdx = -1;
        let bestDist = Infinity;
        for (let i = 0; i < groups.length; i++) {
          const g = groups[i];
          if (!g.visible) continue;
          const s = g.scale.x;
          pickSphere.center.set(g.position.x, g.position.y + 0.72 * s, g.position.z);
          pickSphere.radius = 2.85 * s;
          if (raycaster.ray.intersectSphere(pickSphere, hitPoint)) {
            const dist = raycaster.ray.origin.distanceToSquared(hitPoint);
            if (dist < bestDist) {
              bestDist = dist;
              bestIdx = i;
            }
          }
        }
        return bestIdx;
      },
      dispose() {
        disposed = true;
        renderer.dispose();
      },
    };
  } catch (error) {
    disposed = true;
    renderer.dispose();
    throw error;
  }
}
