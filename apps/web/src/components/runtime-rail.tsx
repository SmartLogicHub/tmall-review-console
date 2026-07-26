import { Check, Sparkles } from "lucide-react";

const steps = ["读取评论", "判断分类", "选择话术", "修正产品信息", "生成草稿"];

export function RuntimeRail({ active = 0 }: { active?: number }) {
  return (
    <div className="runtime-rail" aria-label="评论处理进度">
      {steps.map((step, index) => (
        <div className={`rail-step ${index <= active ? "rail-active" : ""}`} key={step}>
          <span className="rail-node">{index < active ? <Check size={14} /> : <Sparkles size={14} />}</span>
          <span>{step}</span>
          {index < steps.length - 1 && <i aria-hidden="true" />}
        </div>
      ))}
    </div>
  );
}
