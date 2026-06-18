import {
    Vector2,
    Vector4,
    Color,
    MeshNormalMaterial,
    ShaderMaterial,
    WebGLRenderTarget,
    RGBAFormat,
    NearestFilter,
} from 'three'
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js'

class CustomOutlinePass extends Pass {
    constructor(resolution, scene, camera) {
        super()

        this.renderScene = scene
        this.renderCamera = camera
        this.resolution = new Vector2(resolution.x, resolution.y)

        // 一个铺满全屏的四边形,用来跑我们的后期 shader
        this.fsQuad = new FullScreenQuad()
        this.fsQuad.material = this.createOutlinePostProcessMaterial()

        // 用来存「法线缓冲」的离屏 target
        const normalTarget = new WebGLRenderTarget(this.resolution.x, this.resolution.y)
        normalTarget.texture.format = RGBAFormat
        normalTarget.texture.minFilter = NearestFilter
        normalTarget.texture.magFilter = NearestFilter
        normalTarget.texture.generateMipmaps = false
        normalTarget.stencilBuffer = false
        this.normalTarget = normalTarget

        // 把整个场景的材质临时替换成「法线材质」时用的
        this.normalOverrideMaterial = new MeshNormalMaterial()
    }

    dispose() {
        this.normalTarget.dispose()
        this.fsQuad.dispose()
    }

    setSize(width, height) {
        this.normalTarget.setSize(width, height)
        this.resolution.set(width, height)
        this.fsQuad.material.uniforms.screenSize.value.set(
            this.resolution.x,
            this.resolution.y,
            1 / this.resolution.x,
            1 / this.resolution.y
        )
    }

    render(renderer, writeBuffer, readBuffer) {
        // 后面要读深度,先临时关掉对深度的写入,避免冲突
        const depthBufferValue = writeBuffer.depthBuffer
        writeBuffer.depthBuffer = false

        // === 第2趟渲染:把整个场景用法线材质重画一遍,存进 normalTarget ===
        renderer.setRenderTarget(this.normalTarget)
        const overrideMaterialValue = this.renderScene.overrideMaterial
        this.renderScene.overrideMaterial = this.normalOverrideMaterial
        renderer.render(this.renderScene, this.renderCamera)
        this.renderScene.overrideMaterial = overrideMaterialValue

        // 把3个缓冲喂给 shader
        this.fsQuad.material.uniforms['depthBuffer'].value = readBuffer.depthTexture
        this.fsQuad.material.uniforms['normalBuffer'].value = this.normalTarget.texture
        this.fsQuad.material.uniforms['sceneColorBuffer'].value = readBuffer.texture

        // === 跑后期 shader:画描边并叠加到场景 ===
        if (this.renderToScreen) {
            renderer.setRenderTarget(null)        // 这是最后一道,直接画到屏幕
            this.fsQuad.render(renderer)
        } else {
            renderer.setRenderTarget(writeBuffer) // 否则交给下一道 pass(比如 FXAA)
            this.fsQuad.render(renderer)
        }

        writeBuffer.depthBuffer = depthBufferValue // 还原
    }

    get vertexShader() {
        return `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `
    }

    get fragmentShader() {
        return `
            #include <packing>
            // 上面这行让我们能用 ThreeJS 内置的深度解码函数

            uniform sampler2D sceneColorBuffer;
            uniform sampler2D depthBuffer;
            uniform sampler2D normalBuffer;
            uniform float cameraNear;
            uniform float cameraFar;
            uniform vec4 screenSize;       // (宽, 高, 1/宽, 1/高)
            uniform vec3 outlineColor;
            uniform vec4 multiplierParameters; // (depthBias, depthMult, normalBias, normalMult)
            uniform int debugVisualize;

            varying vec2 vUv;

            // 把深度纹理里的非线性值,解码成线性的 [0,1] 深度
            float readDepth(sampler2D depthSampler, vec2 coord) {
                float fragCoordZ = texture2D(depthSampler, coord).x;
                float viewZ = perspectiveDepthToViewZ(fragCoordZ, cameraNear, cameraFar);
                return viewZToOrthographicDepth(viewZ, cameraNear, cameraFar);
            }

            // 读取偏移 (x,y) 个像素处的深度 / 法线
            float getPixelDepth(int x, int y) {
                return readDepth(depthBuffer, vUv + screenSize.zw * vec2(x, y));
            }
            vec3 getPixelNormal(int x, int y) {
                return texture2D(normalBuffer, vUv + screenSize.zw * vec2(x, y)).rgb;
            }

            float saturateValue(float num) {
                return clamp(num, 0.0, 1.0);
            }

            void main() {
                vec4 sceneColor = texture2D(sceneColorBuffer, vUv);
                float depth = getPixelDepth(0, 0);
                vec3 normal = getPixelNormal(0, 0);

                // --- 深度差:检测外轮廓 ---
                float depthDiff = 0.0;
                depthDiff += abs(depth - getPixelDepth(1, 0));
                depthDiff += abs(depth - getPixelDepth(-1, 0));
                depthDiff += abs(depth - getPixelDepth(0, 1));
                depthDiff += abs(depth - getPixelDepth(0, -1));

                // --- 法线差:检测内部折角(含对角线,描边更准) ---
                float normalDiff = 0.0;
                normalDiff += distance(normal, getPixelNormal(1, 0));
                normalDiff += distance(normal, getPixelNormal(-1, 0));
                normalDiff += distance(normal, getPixelNormal(0, 1));
                normalDiff += distance(normal, getPixelNormal(0, -1));
                normalDiff += distance(normal, getPixelNormal(1, 1));
                normalDiff += distance(normal, getPixelNormal(1, -1));
                normalDiff += distance(normal, getPixelNormal(-1, 1));
                normalDiff += distance(normal, getPixelNormal(-1, -1));

                // 用 bias / multiplier 调节灵敏度
                float depthBias    = multiplierParameters.x;
                float depthMult    = multiplierParameters.y;
                float normalBias   = multiplierParameters.z;
                float normalMult   = multiplierParameters.w;

                depthDiff = pow(saturateValue(depthDiff * depthMult), depthBias);
                normalDiff = pow(saturateValue(normalDiff * normalMult), normalBias);

                float outline = saturateValue(normalDiff + depthDiff);

                // 把描边颜色混合进场景
                vec4 finalOutlineColor = vec4(outlineColor, 1.0);
                gl_FragColor = mix(sceneColor, finalOutlineColor, outline);

                // --- 调试视图(学习用,看各个缓冲长啥样)---
                if (debugVisualize == 1) gl_FragColor = sceneColor;
                if (debugVisualize == 2) gl_FragColor = vec4(vec3(depth), 1.0);
                if (debugVisualize == 3) gl_FragColor = vec4(normal, 1.0);
                if (debugVisualize == 4) gl_FragColor = vec4(vec3(outline) * outlineColor, 1.0);
            }
        `
    }

    createOutlinePostProcessMaterial() {
        return new ShaderMaterial({
            uniforms: {
                debugVisualize: { value: 0 },
                sceneColorBuffer: {},
                depthBuffer: {},
                normalBuffer: {},
                outlineColor: { value: new Color(0xffffff) },
                multiplierParameters: { value: new Vector4(1, 1, 1, 1) },
                cameraNear: { value: this.renderCamera.near },
                cameraFar: { value: this.renderCamera.far },
                screenSize: {
                    value: new Vector4(
                        this.resolution.x,
                        this.resolution.y,
                        1 / this.resolution.x,
                        1 / this.resolution.y
                    ),
                },
            },
            vertexShader: this.vertexShader,
            fragmentShader: this.fragmentShader,
        })
    }
}

export default CustomOutlinePass