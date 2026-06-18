/**
 * 六宫格文字标签（用 JS 创建并内联样式,最稳妥）
 */
const labelTexts = [
    '1. Scene Buffer',
    '2. Depth Buffer',
    '3. Normal Buffer',
    '4. Outlines from depth',
    '5. Outlines from depth + normal',
    '6. Outlines + Scene',
]

const labelContainer = document.createElement('div')
Object.assign(labelContainer.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '100%',
    height: '100%',
    zIndex: '9999',          // 盖在 canvas 之上
    pointerEvents: 'none',   // 不挡 OrbitControls
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gridTemplateRows: 'repeat(2, 1fr)',
})

labelTexts.forEach((text) => {
    const span = document.createElement('span')
    span.textContent = text
    Object.assign(span.style, {
        alignSelf: 'end',
        justifySelf: 'center',
        marginBottom: '8px',
        color: '#ffffff',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '14px',
        whiteSpace: 'nowrap',
        textShadow: '0 1px 3px rgba(0,0,0,0.9)',
    })
    labelContainer.appendChild(span)
})

document.body.appendChild(labelContainer)

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import GUI from 'lil-gui'

/**
 * Base
 */
const gui = new GUI()
const canvas = document.querySelector('canvas.webgl')
const scene = new THREE.Scene()

/**
 * Lights
 */
const ambientLight = new THREE.AmbientLight(0xffffff, 1.5)
scene.add(ambientLight)
const directionalLight = new THREE.DirectionalLight(0xffffff, 2)
directionalLight.position.set(5, 5, 5)
scene.add(directionalLight)

const lightFolder = gui.addFolder('灯光控制 (Lights)')
lightFolder.add(ambientLight, 'intensity').min(0).max(5).step(0.01).name('环境光强度')
lightFolder.add(directionalLight, 'intensity').min(0).max(5).step(0.01).name('平行光强度')

/**
 * Sizes
 */
const sizes = { width: window.innerWidth, height: window.innerHeight }

/**
 * Camera —— 注意:相机的宽高比要按「单个格子」算,而不是整个屏幕,
 * 否则画面会被拉伸变形
 */
const camera = new THREE.PerspectiveCamera(25, 1, 0.1, 100)
camera.position.set(7, 7, 7)
scene.add(camera)

const controls = new OrbitControls(camera, canvas)
controls.enableDamping = true

/**
 * Renderer
 */
const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true })
renderer.setSize(sizes.width, sizes.height)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
const dpr = Math.min(window.devicePixelRatio, 2)

/**
 * 离屏缓冲:一张存「场景颜色 + 深度」,一张存「法线」
 */
const depthTexture = new THREE.DepthTexture(1, 1)
const sceneRT = new THREE.WebGLRenderTarget(1, 1, {
    depthTexture: depthTexture,
    depthBuffer: true,
})
const normalRT = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.NearestFilter, // 法线要逐像素精确,禁止插值抹匀
    magFilter: THREE.NearestFilter,
})

// 渲染法线缓冲时,临时套在全场景上的材质
const normalMaterial = new THREE.MeshNormalMaterial()

/**
 * 全屏四边形 + 边缘检测 shader（六种模式塞在一个 shader 里）
 */
const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
const quadScene = new THREE.Scene()

const outlineParams = { color: '#ffffff', depthBias: 1, depthMult: 1, normalBias: 0.5, normalMult: 1 }

const quadMaterial = new THREE.ShaderMaterial({
    uniforms: {
        tColor:       { value: sceneRT.texture },
        tDepth:       { value: sceneRT.depthTexture },
        tNormal:      { value: normalRT.texture },
        cameraNear:   { value: camera.near },
        cameraFar:    { value: camera.far },
        uTexel:       { value: new THREE.Vector2() },
        uOutlineColor:{ value: new THREE.Color(0xffffff) },
        uParams:      { value: new THREE.Vector4(1, 1, 1, 1) }, // depthBias, depthMult, normalBias, normalMult
        uMode:        { value: 0 },
    },
    depthTest: false,
    depthWrite: false,
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
        }
    `,
    fragmentShader: `
        #include <packing>

        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform sampler2D tNormal;
        uniform float cameraNear;
        uniform float cameraFar;
        uniform vec2 uTexel;
        uniform vec3 uOutlineColor;
        uniform vec4 uParams;
        uniform int uMode;

        varying vec2 vUv;

        float readDepth(vec2 uv) {
            float z = texture2D(tDepth, uv).x;
            float viewZ = perspectiveDepthToViewZ(z, cameraNear, cameraFar);
            return viewZToOrthographicDepth(viewZ, cameraNear, cameraFar);
        }
        vec3 readNormal(vec2 uv) { return texture2D(tNormal, uv).rgb; }
        float sat(float x) { return clamp(x, 0.0, 1.0); }

        void main() {
            vec2 uv = vUv;
            vec4 sceneColor = texture2D(tColor, uv);
            float depth = readDepth(uv);
            vec3 normal = readNormal(uv);

            // 深度差（上下左右）
            float depthDiff = 0.0;
            depthDiff += abs(depth - readDepth(uv + uTexel * vec2(1.0, 0.0)));
            depthDiff += abs(depth - readDepth(uv + uTexel * vec2(-1.0, 0.0)));
            depthDiff += abs(depth - readDepth(uv + uTexel * vec2(0.0, 1.0)));
            depthDiff += abs(depth - readDepth(uv + uTexel * vec2(0.0, -1.0)));

            // 法线差（含对角线）
            float normalDiff = 0.0;
            normalDiff += distance(normal, readNormal(uv + uTexel * vec2(1.0, 0.0)));
            normalDiff += distance(normal, readNormal(uv + uTexel * vec2(-1.0, 0.0)));
            normalDiff += distance(normal, readNormal(uv + uTexel * vec2(0.0, 1.0)));
            normalDiff += distance(normal, readNormal(uv + uTexel * vec2(0.0, -1.0)));
            normalDiff += distance(normal, readNormal(uv + uTexel * vec2(1.0, 1.0)));
            normalDiff += distance(normal, readNormal(uv + uTexel * vec2(1.0, -1.0)));
            normalDiff += distance(normal, readNormal(uv + uTexel * vec2(-1.0, 1.0)));
            normalDiff += distance(normal, readNormal(uv + uTexel * vec2(-1.0, -1.0)));

            float depthBias = uParams.x;
            float depthMult = uParams.y;
            float normalBias = uParams.z;
            float normalMult = uParams.w;

            float dOutline = pow(sat(depthDiff * depthMult), depthBias);
            float nOutline = pow(sat(normalDiff * normalMult), normalBias);
            float outline = sat(dOutline + nOutline);

            vec3 result;
            if (uMode == 0) {            // 1. Scene
                result = sceneColor.rgb;
            } else if (uMode == 1) {     // 2. Depth：背景黑,越近越亮
                if (depth >= 0.999) {
                    result = vec3(0.0);                       // 空背景 → 纯黑
                } else {
                    // 把物体所在的深度区间拉伸开,让明暗层次明显
                    result = vec3(sat((1.0 - depth - 0.80) / 0.18));
                }
            } else if (uMode == 2) {     // 3. Normal（本来就是黑底）
                result = normal;
            } else if (uMode == 3) {     // 4. 仅深度描边：黑底 + 描边色
                result = uOutlineColor * dOutline;
            } else if (uMode == 4) {     // 5. 深度+法线描边：黑底 + 描边色
                result = uOutlineColor * outline;
            } else {                      // 6. 描边 + 场景
                result = mix(sceneColor.rgb, uOutlineColor, outline);
            }
            gl_FragColor = vec4(result, 1.0);
        }
    `,
})
quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMaterial))

// 描边参数面板
const updateParams = () => {
    quadMaterial.uniforms.uParams.value.set(
        outlineParams.depthBias, outlineParams.depthMult,
        outlineParams.normalBias, outlineParams.normalMult
    )
}
const outlineFolder = gui.addFolder('Outline Control')
outlineFolder.addColor(outlineParams, 'color').name('Outline Color')
    .onChange(v => quadMaterial.uniforms.uOutlineColor.value.set(v))
outlineFolder.add(outlineParams, 'depthMult').min(0).max(20).step(0.01).name('Depth Strength').onChange(updateParams)
outlineFolder.add(outlineParams, 'depthBias').min(0).max(5).step(0.01).name('Depth Bias').onChange(updateParams)
outlineFolder.add(outlineParams, 'normalMult').min(0).max(10).step(0.01).name('Normal Strength').onChange(updateParams)
outlineFolder.add(outlineParams, 'normalBias').min(0).max(5).step(0.01).name('Normal Bias').onChange(updateParams)
/**
 * 六宫格布局参数
 */
const GAP = 8       // 每格四周留白
const LABEL_H = 24  // 每格底部给标签留的高度

// 当前单个格子的视口尺寸（CSS 像素），resize 时更新
let vpW = 1, vpH = 1

// 当前网格的列数 / 行数,会随屏幕方向变化
let cols = 3
let rows = 2

const getLayout = () => {
    // 竖屏(高 > 宽)→ 2列3行;横屏 → 3列2行
    return window.innerHeight > window.innerWidth
        ? { cols: 2, rows: 3 }
        : { cols: 3, rows: 2 }
}

const updateSizes = () => {
    sizes.width = window.innerWidth
    sizes.height = window.innerHeight

    // 根据屏幕方向决定列数 / 行数
    const layout = getLayout()
    cols = layout.cols
    rows = layout.rows

    const cellW = sizes.width / cols
    const cellH = sizes.height / rows
    vpW = cellW - 2 * GAP
    vpH = cellH - 2 * GAP - LABEL_H

    // 相机宽高比 = 单个格子的宽高比
    camera.aspect = vpW / vpH
    camera.updateProjectionMatrix()

    renderer.setSize(sizes.width, sizes.height)
    renderer.setPixelRatio(dpr)

    const rtW = Math.max(1, Math.round(vpW * dpr))
    const rtH = Math.max(1, Math.round(vpH * dpr))
    sceneRT.setSize(rtW, rtH)
    normalRT.setSize(rtW, rtH)

    quadMaterial.uniforms.uTexel.value.set(1 / rtW, 1 / rtH)
    quadMaterial.uniforms.cameraNear.value = camera.near
    quadMaterial.uniforms.cameraFar.value = camera.far

    // 同步文字标签的网格,让它和 WebGL 的格子对齐
    labelContainer.style.gridTemplateColumns = `repeat(${cols}, 1fr)`
    labelContainer.style.gridTemplateRows = `repeat(${rows}, 1fr)`
}
window.addEventListener('resize', updateSizes)

/**
 * Objects
 */
const gltfLoader = new GLTFLoader()
let taxiModel = null
gltfLoader.load(    
    import.meta.env.BASE_URL + 'going_merry.glb',   // ← 改这里
    (gltf) =>  {
    taxiModel = gltf.scene
    scene.add(taxiModel)
    console.log('模型加载成功！')
}, undefined, (e) => console.error('模型加载报错：', e))

/**
 * Animate
 */
const clock = new THREE.Clock()

const tick = () => {
    const elapsedTime = clock.getElapsedTime()

    if (taxiModel) taxiModel.rotation.y = elapsedTime * 0.2

    controls.target.set(0, 2.5, 0)  // y 往上抬,具体数值看你的模型高度微调
    controls.update()

    // === 第1趟：渲染场景颜色 + 深度，存进 sceneRT ===
    renderer.setScissorTest(false)
    renderer.setRenderTarget(sceneRT)
    renderer.setClearColor(0x000000, 1)
    renderer.clear()
    renderer.render(scene, camera)

    // === 第2趟：用法线材质重渲一遍,存进 normalRT ===
    renderer.setRenderTarget(normalRT)
    renderer.setClearColor(0x000000, 1)
    renderer.clear()
    scene.overrideMaterial = normalMaterial
    renderer.render(scene, camera)
    scene.overrideMaterial = null

    // === 回到屏幕,先整屏清成黑色（格子之间的缝隙）===
    renderer.setRenderTarget(null)
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, sizes.width, sizes.height)
    renderer.setClearColor(0x000000, 1)
    renderer.clear()

    // === 六个格子,每格用不同的 uMode 画一次全屏 quad ===
    const cellW = sizes.width / cols
    const cellH = sizes.height / rows
    renderer.setScissorTest(true)
    for (let i = 0; i < 6; i++) {
        const col = i % cols
        const row = Math.floor(i / cols)
        const x = col * cellW + GAP
        const topY = row * cellH + GAP
        const y = sizes.height - (topY + vpH)

        renderer.setViewport(x, y, vpW, vpH)
        renderer.setScissor(x, y, vpW, vpH)
        quadMaterial.uniforms.uMode.value = i
        renderer.render(quadScene, quadCamera)
    }
    renderer.setScissorTest(false)

    window.requestAnimationFrame(tick)
}

updateSizes() // 先算一次尺寸
tick()


