import { useEffect, useRef } from 'react';
import { IdleAnimation, SkinViewer } from 'skinview3d';
import { DirectionalLight, Mesh, MeshStandardMaterial } from 'three';

type Props = {
  skinUrl?: string;
  model?: 'default' | 'slim';
};

export function SkinPreview3D({ skinUrl, model = 'default' }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !skinUrl) return;
    let viewer: SkinViewer | null = null;
    let observer: ResizeObserver | null = null;
    try {
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      viewer = new SkinViewer({
        canvas,
        width: Math.max(200, container.clientWidth),
        height: Math.max(220, container.clientHeight),
        skin: skinUrl,
        model,
        animation: reducedMotion ? undefined : new IdleAnimation(),
        enableControls: true,
        zoom: 0.84,
      });
      viewer.playerObject.skin.setInnerLayerVisible(true);
      viewer.playerObject.skin.setOuterLayerVisible(true);
      viewer.renderer.setClearAlpha(0);
      viewer.autoRotate = !reducedMotion;
      viewer.autoRotateSpeed = 0.38;
      viewer.controls.enablePan = false;
      viewer.controls.enableZoom = false;
      viewer.globalLight.intensity = 1.7;
      viewer.cameraLight.intensity = 0;
      viewer.playerObject.skin.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (!(material instanceof MeshStandardMaterial)) continue;
          material.metalness = 0;
          material.roughness = 1;
          material.envMapIntensity = 0;
          material.needsUpdate = true;
        }
      });
      const key = new DirectionalLight(0xffffff, 0.45);
      key.position.set(4, 7, 6);
      viewer.scene.add(key);
      const fill = new DirectionalLight(0xffffff, 0.15);
      fill.position.set(-5, 2, 4);
      viewer.scene.add(fill);
      viewer.fxaaPass.enabled = true;

      const activeViewer = viewer;
      observer = new ResizeObserver(() => {
        activeViewer.setSize(Math.max(200, container.clientWidth), Math.max(220, container.clientHeight));
      });
      observer.observe(container);
    } catch (error) {
      console.error('Не удалось показать 3D-скин:', error);
    }
    return () => {
      observer?.disconnect();
      viewer?.dispose();
    };
  }, [skinUrl, model]);

  return (
    <div className="skin-viewer-canvas" ref={containerRef}>
      {skinUrl
        ? <canvas ref={canvasRef} aria-label="3D-просмотр скина Minecraft" />
        : <div className="skin-preview-unavailable" aria-hidden="true" />}
    </div>
  );
}
