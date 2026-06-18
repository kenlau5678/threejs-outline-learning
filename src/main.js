import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import GUI from 'lil-gui'

import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js'
import CustomOutlinePass from './CustomOutlinePass.js'

/**
 * Base
 */
// Debug
const gui = new GUI()

// Canvas
const canvas = document.querySelector('canvas.webgl')

// Scene
const scene = new THREE.Scene()

/**
 * Lights (必须添加灯光，否则 glb 模型自带的材质会是一片死黑)
 */
// 环境光（提供基础亮度，没有阴影）
const ambientLight = new THREE.AmbientLight(0xffffff, 1.5)
scene.add(ambientLight)

// 平行光（模拟太阳光，提供立体感）
const directionalLight = new THREE.DirectionalLight(0xffffff, 2)
directionalLight.position.set(5, 5, 5)
scene.add(directionalLight)

// 在调试面板中加入控制灯光强度的开关
const lightFolder = gui.addFolder('灯光控制 (Lights)')
lightFolder.add(ambientLight, 'intensity').min(0).max(5).step(0.01).name('环境光强度')
lightFolder.add(directionalLight, 'intensity').min(0).max(5).step(0.01).name('平行光强度')

/**
 * Sizes
 */
const sizes = {
    width: window.innerWidth,
    height: window.innerHeight
}

window.addEventListener('resize', () =>
{
    sizes.width = window.innerWidth
    sizes.height = window.innerHeight

    camera.aspect = sizes.width / sizes.height
    camera.updateProjectionMatrix()

    renderer.setSize(sizes.width, sizes.height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

    // 更新后期管线
    composer.setSize(sizes.width, sizes.height)
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    fxaaPass.uniforms['resolution'].value.set(1 / sizes.width, 1 / sizes.height)
})

/**
 * Camera
 */
// Base camera
const camera = new THREE.PerspectiveCamera(32, sizes.width / sizes.height, 0.1, 100)
camera.position.set(7, 7, 7)
scene.add(camera)


// Controls
const controls = new OrbitControls(camera, canvas)
controls.enableDamping = true

/**
 * Renderer
 */
const rendererParameters = {
    clearColor: '#212121'
}

const renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true
})
renderer.setClearColor(rendererParameters.clearColor)
renderer.setSize(sizes.width, sizes.height)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

// 在调试面板控制背景色
gui
    .addColor(rendererParameters, 'clearColor')
    .onChange(() =>
    {
        renderer.setClearColor(rendererParameters.clearColor)
    })

/**
 * Post Processing - 描边管线
 */
// 创建一张深度纹理,让第一趟渲染把深度写进来
const depthTexture = new THREE.DepthTexture()
const renderTarget = new THREE.WebGLRenderTarget(
    sizes.width,
    sizes.height,
    {
        depthTexture: depthTexture,
        depthBuffer: true,
    }
)

// EffectComposer 用我们这张带深度的 renderTarget
const composer = new EffectComposer(renderer, renderTarget)

// Pass 1:正常渲染场景(颜色进 readBuffer,深度进 depthTexture)
const renderPass = new RenderPass(scene, camera)
composer.addPass(renderPass)

// Pass 2:描边后期处理
const outlinePass = new CustomOutlinePass(
    new THREE.Vector2(sizes.width, sizes.height),
    scene,
    camera
)
composer.addPass(outlinePass)

/**
 * 描边调试面板
 */
const outlineParams = {
    outlineColor: '#ffffff',
    depthBias: 1,      // 越大,只有深度差很猛的地方才描边
    depthMult: 1,      // 深度差的整体强度
    normalBias: 1.5,     // 越大,只有折角很尖的地方才描边
    normalMult: 1,     // 法线差的整体强度
    debug: '正常输出',
}

// 把4个参数打包进 multiplierParameters 这个 Vector4
const updateMultiplier = () =>
{
    outlinePass.fsQuad.material.uniforms.multiplierParameters.value.set(
        outlineParams.depthBias,
        outlineParams.depthMult,
        outlineParams.normalBias,
        outlineParams.normalMult
    )
}

const debugModes = { '正常输出': 0, '场景颜色': 1, '深度缓冲': 2, '法线缓冲': 3, '仅描边': 4 }

const outlineFolder = gui.addFolder('描边控制 (Outline)')
outlineFolder.addColor(outlineParams, 'outlineColor').name('描边颜色').onChange((v) =>
{
    outlinePass.fsQuad.material.uniforms.outlineColor.value.set(v)
})
outlineFolder.add(outlineParams, 'depthBias').min(0).max(5).step(0.01).name('深度Bias').onChange(updateMultiplier)
outlineFolder.add(outlineParams, 'depthMult').min(0).max(10).step(0.01).name('深度强度').onChange(updateMultiplier)
outlineFolder.add(outlineParams, 'normalBias').min(0).max(5).step(0.01).name('法线Bias').onChange(updateMultiplier)
outlineFolder.add(outlineParams, 'normalMult').min(0).max(10).step(0.01).name('法线强度').onChange(updateMultiplier)
outlineFolder.add(outlineParams, 'debug', Object.keys(debugModes)).name('调试视图').onChange((v) =>
{
    outlinePass.fsQuad.material.uniforms.debugVisualize.value = debugModes[v]
})



// Pass 3:FXAA 抗锯齿(因为渲染到了离屏缓冲,浏览器自带抗锯齿失效了)
const fxaaPass = new ShaderPass(FXAAShader)
fxaaPass.uniforms['resolution'].value.set(1 / sizes.width, 1 / sizes.height)
composer.addPass(fxaaPass)



/**
 * Objects - 加载 taxi.glb 并保留原有贴图
 */
const gltfLoader = new GLTFLoader()
let taxiModel = null

gltfLoader.load(
    import.meta.env.BASE_URL + 'going_merry.glb',   // ← 改这里
    (gltf) => 
    {
        taxiModel = gltf.scene
        
        // 我们不再重写 child.material，保留模型本来的材质！
        
        // 将模型添加到场景中
        scene.add(taxiModel)
        console.log('模型加载成功！')
    },
    (xhr) => {
        console.log((xhr.loaded / xhr.total * 100) + '% loaded')
    },
    (error) => {
        console.error('模型加载报错：', error)
    }
)

/**
 * Animate
 */
const clock = new THREE.Clock()

const tick = () =>
{
    const elapsedTime = clock.getElapsedTime()

    // 如果出租车模型加载成功，让它自己缓缓转动
    if(taxiModel) {
        taxiModel.rotation.y = elapsedTime * 0.2
    }

    // Update controls
    controls.target.set(0, 2.5, 0)  // y 往上抬,具体数值看你的模型高度微调
    controls.update()

    // Render
    composer.render()

    // Call tick again on the next frame
    window.requestAnimationFrame(tick)
}

tick()


