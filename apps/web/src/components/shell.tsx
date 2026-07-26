import { BookOpenText, ClipboardList, FileCheck2, LayoutDashboard, Settings, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

const navigation = [
  { to: "/", label: "工作台", icon: LayoutDashboard },
  { to: "/replies", label: "回复结果", icon: FileCheck2 },
  { to: "/complaints", label: "投诉记录", icon: ShieldAlert },
  { to: "/templates", label: "话术库", icon: BookOpenText },
  { to: "/manual-products", label: "自动跳过商品", icon: ClipboardList },
  { to: "/settings", label: "设置", icon: Settings },
];

export function Shell() {
  const location = useLocation();
  useEffect(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [location.pathname]);
  return (
    <div className="app-frame">
      <aside className="sidebar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">评</span>
          <div><strong>评论助手</strong><small>自动回复控制台</small></div>
        </div>
        <nav aria-label="主导航">
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === "/"} aria-label={label} className={({ isActive }) => isActive ? "nav-item active" : "nav-item"}>
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-safety">
          <ShieldCheck size={18} />
        <div><strong>自动回复</strong><span>单条异常自动跳过</span></div>
        </div>
      </aside>
      <main className="workspace">
        <div className="page-scroll"><Outlet /></div>
      </main>
    </div>
  );
}
