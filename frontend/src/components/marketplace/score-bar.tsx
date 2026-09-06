export function ScoreBar({ label, score, weight }: { label: string; score: number; weight: number }) {
  const percent = Math.round(score * 100);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="capitalize text-muted-foreground">{label} <span className="text-[10px]">({Math.round(weight * 100)}%)</span></span>
        <span className="font-mono font-semibold">{percent}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
        <div className="h-full rounded-full bg-foreground transition-[width]" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
