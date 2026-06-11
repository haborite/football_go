// 碁盤球の3D描画とインタラクション（Three.js）
// - サッカーボール風の碁盤球（五角形面を濃色に）
// - ドラッグで回転（OrbitControls）、ビュープリセット、反対側のインセットビュー
// - 頂点クリック判定とゴースト石のホバー表示

import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { EDGES, N, PENTAGON_DIRS, VERTS } from '../shared/geometry';

export interface SceneCallbacks {
  /** 頂点がクリックされた */
  onPointClick(p: number): void;
  /** ゴースト石の色（1=黒, 2=白, 0=表示しない） */
  ghostColor(): 0 | 1 | 2;
  /** この点に今打てるか（ホバー表示用） */
  canPlay(p: number): boolean;
}

const SPHERE_R = 0.97;
const PENTAGON_R = 0.978;
const LINE_R = 0.988;
const STONE_R = 0.155;
const STONE_FLAT = 0.58;
const DEFAULT_DIR = new THREE.Vector3(0.45, 0.35, 0.85).normalize();
const DEFAULT_DIST = 3.15;

function vec(i: number): THREE.Vector3 {
  return new THREE.Vector3(VERTS[i][0], VERTS[i][1], VERTS[i][2]);
}

function subdivTri(
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  depth: number,
  r: number,
  out: number[]
) {
  if (depth === 0) {
    for (const v of [a, b, c]) {
      const u = v.clone().normalize().multiplyScalar(r);
      out.push(u.x, u.y, u.z);
    }
    return;
  }
  const ab = a.clone().add(b).normalize();
  const bc = b.clone().add(c).normalize();
  const ca = c.clone().add(a).normalize();
  subdivTri(a, ab, ca, depth - 1, r, out);
  subdivTri(ab, b, bc, depth - 1, r, out);
  subdivTri(ca, bc, c, depth - 1, r, out);
  subdivTri(ab, bc, ca, depth - 1, r, out);
}

export class BoardScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private insetCamera: THREE.PerspectiveCamera;
  private controls: TrackballControls;
  private dirLight: THREE.DirectionalLight;
  private container: HTMLElement;
  private insetFrame: HTMLElement;
  private callbacks: SceneCallbacks;

  private verts: THREE.Vector3[] = [];
  private stoneGroup = new THREE.Group();
  private ghost: THREE.Mesh;
  private marker: THREE.Mesh;
  private stoneGeo: THREE.SphereGeometry;
  private blackMat: THREE.MeshStandardMaterial;
  private whiteMat: THREE.MeshStandardMaterial;
  private ghostBlackMat: THREE.MeshStandardMaterial;
  private ghostWhiteMat: THREE.MeshStandardMaterial;

  private board = new Uint8Array(N);
  private hoverPoint = -1;
  private downPos: { x: number; y: number } | null = null;
  private tween: { dir: THREE.Vector3; dist: number; up: THREE.Vector3 } | null = null;
  private raycaster = new THREE.Raycaster();

  constructor(container: HTMLElement, insetFrame: HTMLElement, callbacks: SceneCallbacks) {
    this.container = container;
    this.insetFrame = insetFrame;
    this.callbacks = callbacks;

    for (let i = 0; i < N; i++) this.verts.push(vec(i));

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.domElement.id = 'board-canvas';
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      42,
      container.clientWidth / container.clientHeight,
      0.1,
      100
    );
    this.camera.position.copy(DEFAULT_DIR).multiplyScalar(DEFAULT_DIST);
    this.insetCamera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);

    // TrackballControls: 極で固定されない全方向の自由回転（OrbitControlsの
    // 上下回転ロックを避けるため）
    this.controls = new TrackballControls(this.camera, this.renderer.domElement);
    this.controls.noPan = true;
    this.controls.rotateSpeed = 2.4;
    this.controls.zoomSpeed = 1.1;
    this.controls.staticMoving = false;
    this.controls.dynamicDampingFactor = 0.16;
    this.controls.minDistance = 2.0;
    this.controls.maxDistance = 6.5;
    this.controls.addEventListener('start', () => {
      this.tween = null;
    });

    // 照明（カメラ追従のライトで常に表面が見えるように）
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    this.dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.scene.add(this.dirLight);

    // 碁盤球本体
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(SPHERE_R, 64, 48),
      new THREE.MeshStandardMaterial({ color: 0xd9b36c, roughness: 0.82, metalness: 0.02 })
    );
    this.scene.add(sphere);

    this.scene.add(this.buildPentagons());
    this.scene.add(this.buildEdges());
    this.scene.add(this.buildVertexDots());

    // 石
    this.stoneGeo = new THREE.SphereGeometry(STONE_R, 32, 20);
    this.blackMat = new THREE.MeshStandardMaterial({ color: 0x191919, roughness: 0.32 });
    this.whiteMat = new THREE.MeshStandardMaterial({ color: 0xf3f3ec, roughness: 0.22 });
    this.ghostBlackMat = new THREE.MeshStandardMaterial({
      color: 0x191919,
      roughness: 0.4,
      transparent: true,
      opacity: 0.45,
    });
    this.ghostWhiteMat = new THREE.MeshStandardMaterial({
      color: 0xf3f3ec,
      roughness: 0.4,
      transparent: true,
      opacity: 0.5,
    });
    this.scene.add(this.stoneGroup);

    this.ghost = new THREE.Mesh(this.stoneGeo, this.ghostBlackMat);
    this.ghost.visible = false;
    this.scene.add(this.ghost);

    // 最終着手マーカー（石の上の赤いリング）
    this.marker = new THREE.Mesh(
      new THREE.TorusGeometry(0.055, 0.013, 10, 28),
      new THREE.MeshBasicMaterial({ color: 0xe0452f })
    );
    this.marker.visible = false;
    this.scene.add(this.marker);

    // 入力
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => {
      this.downPos = { x: e.clientX, y: e.clientY };
    });
    dom.addEventListener('pointerup', (e) => {
      const d = this.downPos;
      this.downPos = null;
      if (!d) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return; // ドラッグは無視
      const p = this.pickVertex(e.clientX, e.clientY);
      if (p >= 0) this.callbacks.onPointClick(p);
    });
    dom.addEventListener('pointermove', (e) => {
      this.hoverPoint = this.pickVertex(e.clientX, e.clientY);
    });
    dom.addEventListener('pointerleave', () => {
      this.hoverPoint = -1;
    });

    new ResizeObserver(() => this.onResize()).observe(container);

    this.renderer.setAnimationLoop(() => this.renderFrame());
  }

  private buildPentagons(): THREE.Mesh {
    const positions: number[] = [];
    for (const d of PENTAGON_DIRS) {
      const c = new THREE.Vector3(d[0], d[1], d[2]);
      const nearest = [...Array(N).keys()]
        .map((i) => ({ i, d2: this.verts[i].distanceToSquared(c) }))
        .sort((a, b) => a.d2 - b.d2)
        .slice(0, 5)
        .map((x) => x.i);
      const ref = Math.abs(c.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const t1 = new THREE.Vector3().crossVectors(c, ref).normalize();
      const t2 = new THREE.Vector3().crossVectors(c, t1).normalize();
      const ring = nearest
        .map((i) => {
          const v = this.verts[i];
          return { v, a: Math.atan2(v.dot(t2), v.dot(t1)) };
        })
        .sort((a, b) => a.a - b.a)
        .map((x) => x.v);
      for (let k = 0; k < 5; k++) {
        subdivTri(c, ring[k], ring[(k + 1) % 5], 2, PENTAGON_R, positions);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    // 法線は球面なので放射方向
    const normals = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      const len = Math.hypot(positions[i], positions[i + 1], positions[i + 2]);
      normals[i] = positions[i] / len;
      normals[i + 1] = positions[i + 1] / len;
      normals[i + 2] = positions[i + 2] / len;
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    return new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0x33271a, roughness: 0.85 })
    );
  }

  private buildEdges(): THREE.LineSegments {
    const positions: number[] = [];
    const SEG = 12;
    for (const [i, j] of EDGES) {
      const a = this.verts[i];
      const b = this.verts[j];
      let prev = a.clone().multiplyScalar(LINE_R);
      for (let s = 1; s <= SEG; s++) {
        const t = s / SEG;
        const p = a
          .clone()
          .multiplyScalar(1 - t)
          .add(b.clone().multiplyScalar(t))
          .normalize()
          .multiplyScalar(LINE_R);
        positions.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
        prev = p;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0x3c2c18, transparent: true, opacity: 0.9 })
    );
  }

  private buildVertexDots(): THREE.Group {
    const g = new THREE.Group();
    const geo = new THREE.SphereGeometry(0.017, 10, 8);
    const mat = new THREE.MeshStandardMaterial({ color: 0x3c2c18, roughness: 0.8 });
    for (let i = 0; i < N; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.position.copy(this.verts[i]).multiplyScalar(LINE_R);
      g.add(m);
    }
    return g;
  }

  /** 盤面状態を反映する */
  updateState(board: Uint8Array, lastMove: number) {
    this.board.set(board);
    this.stoneGroup.clear();
    for (let i = 0; i < N; i++) {
      if (board[i] === 0) continue;
      const m = new THREE.Mesh(this.stoneGeo, board[i] === 1 ? this.blackMat : this.whiteMat);
      this.placeLens(m, i, 1.0);
      this.stoneGroup.add(m);
    }
    if (lastMove >= 0 && board[lastMove] !== 0) {
      const v = this.verts[lastMove];
      this.marker.position.copy(v).multiplyScalar(1.0 + STONE_R * STONE_FLAT + 0.012);
      this.marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), v);
      this.marker.visible = true;
    } else {
      this.marker.visible = false;
    }
  }

  private placeLens(mesh: THREE.Mesh, p: number, scale: number) {
    const v = this.verts[p];
    mesh.position.copy(v);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), v);
    mesh.scale.set(scale, scale, STONE_FLAT * scale);
  }

  /** ビュープリセット（dirの方向から盤を見る） */
  viewPreset(dir: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom') {
    const presets: Record<string, { d: [number, number, number]; up: [number, number, number] }> = {
      front: { d: [0, 0, 1], up: [0, 1, 0] },
      back: { d: [0, 0, -1], up: [0, 1, 0] },
      left: { d: [-1, 0, 0], up: [0, 1, 0] },
      right: { d: [1, 0, 0], up: [0, 1, 0] },
      top: { d: [0, 1, 0], up: [0, 0, -1] },
      bottom: { d: [0, -1, 0], up: [0, 0, 1] },
    };
    const p = presets[dir];
    this.tween = {
      dir: new THREE.Vector3(...p.d).normalize(),
      dist: this.camera.position.length(),
      up: new THREE.Vector3(...p.up),
    };
  }

  resetView() {
    this.tween = {
      dir: DEFAULT_DIR.clone(),
      dist: DEFAULT_DIST,
      up: new THREE.Vector3(0, 1, 0),
    };
  }

  private pickVertex(clientX: number, clientY: number): number {
    const rect = this.renderer.domElement.getBoundingClientRect();
    // インセットビュー内は無効
    const fr = this.insetFrame.getBoundingClientRect();
    if (
      clientX >= fr.left &&
      clientX <= fr.right &&
      clientY >= fr.top &&
      clientY <= fr.bottom
    ) {
      return -1;
    }
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const ray = this.raycaster.ray;
    const camPos = this.camera.position;
    let best = -1;
    let bestD = 0.13 * 0.13;
    for (let i = 0; i < N; i++) {
      const v = this.verts[i];
      // 球の裏側（地平線の向こう）は選択不可
      if (v.dot(camPos) <= 1.0) continue;
      const d2 = ray.distanceSqToPoint(v);
      if (d2 < bestD) {
        bestD = d2;
        best = i;
      }
    }
    return best;
  }

  private onResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.controls.handleResize();
  }

  private renderFrame() {
    // ビュープリセットへのなめらかな移動（位置と上方向の両方を補間）
    if (this.tween) {
      const cur = this.camera.position.clone().normalize();
      const target = this.tween.dir;
      const angle = cur.angleTo(target);
      const dist = THREE.MathUtils.lerp(this.camera.position.length(), this.tween.dist, 0.18);
      const upNow = this.camera.up.clone().lerp(this.tween.up, 0.18);
      const upAngle = this.camera.up.angleTo(this.tween.up);
      if (angle < 0.005 && Math.abs(dist - this.tween.dist) < 0.01 && upAngle < 0.01) {
        this.camera.position.copy(target).multiplyScalar(this.tween.dist);
        this.camera.up.copy(this.tween.up);
        this.tween = null;
      } else {
        const q = new THREE.Quaternion().setFromUnitVectors(cur, target);
        const qStep = new THREE.Quaternion().slerp(q, Math.min(1, 0.18));
        this.camera.position.copy(cur.applyQuaternion(qStep)).multiplyScalar(dist);
        // 上方向は視線方向と直交化して正規化
        const d = this.camera.position.clone().normalize();
        upNow.addScaledVector(d, -upNow.dot(d));
        if (upNow.lengthSq() > 1e-8) this.camera.up.copy(upNow.normalize());
      }
      this.camera.lookAt(0, 0, 0);
    }
    this.controls.update();
    this.dirLight.position.copy(this.camera.position);

    // ゴースト石（ホバー中の合法手）
    const gc = this.callbacks.ghostColor();
    const hp = this.hoverPoint;
    const showGhost =
      gc !== 0 && hp >= 0 && this.board[hp] === 0 && this.callbacks.canPlay(hp);
    if (showGhost) {
      this.ghost.material = gc === 1 ? this.ghostBlackMat : this.ghostWhiteMat;
      this.placeLens(this.ghost, hp, 1.0);
      this.ghost.visible = true;
      this.renderer.domElement.style.cursor = 'pointer';
    } else {
      this.ghost.visible = false;
      this.renderer.domElement.style.cursor = 'grab';
    }

    const w = this.container.clientWidth;
    const h = this.container.clientHeight;

    // メインビュー
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, w, h);
    this.renderer.render(this.scene, this.camera);

    // インセットビュー（反対側）
    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    const fr = this.insetFrame.getBoundingClientRect();
    const ix = fr.left - canvasRect.left;
    const iy = canvasRect.bottom - fr.bottom;
    const iw = fr.width;
    const ih = fr.height;
    if (iw > 10 && ih > 10) {
      this.insetCamera.aspect = iw / ih;
      this.insetCamera.updateProjectionMatrix();
      this.insetCamera.position.copy(this.camera.position).negate();
      this.insetCamera.up.copy(this.camera.up);
      this.insetCamera.lookAt(0, 0, 0);
      const ghostWas = this.ghost.visible;
      this.ghost.visible = false; // 裏側ビューにはゴーストを出さない
      this.renderer.setScissorTest(true);
      this.renderer.setViewport(ix, iy, iw, ih);
      this.renderer.setScissor(ix, iy, iw, ih);
      this.renderer.clearDepth();
      this.renderer.render(this.scene, this.insetCamera);
      this.renderer.setScissorTest(false);
      this.ghost.visible = ghostWas;
    }
  }
}
