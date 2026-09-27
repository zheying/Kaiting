import { useEffect, useRef } from "react";
import { startLoginScene } from "./login-scene";

export function LoginBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) return startLoginScene(canvas);
  }, []);

  return <div className="login-rhythm-layer" aria-hidden="true">
    <canvas ref={canvasRef} className="login-rhythm-canvas" />
    <div className="login-rhythm-caption"><span>一首歌 · 一段时光 · 一个更真实的你</span><strong>音乐，始终在这里。</strong></div>
  </div>;
}
