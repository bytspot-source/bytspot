interface BrandLogoProps {
  size?: number;
}

export function BrandLogo({ size = 40 }: BrandLogoProps) {
  return (
    <div
      className="flex items-center justify-center rounded-2xl bg-gradient-to-br from-purple-600 to-cyan-500 shadow-lg"
      style={{ width: size, height: size }}
    >
      <span
        className="font-extrabold text-white leading-none"
        style={{ fontSize: size * 0.45 }}
      >
        B
      </span>
    </div>
  );
}

