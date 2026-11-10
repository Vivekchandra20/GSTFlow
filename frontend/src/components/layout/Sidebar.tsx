import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  UploadCloud,
  FileSpreadsheet,
  Scale,
  AlertTriangle,
  Building2,
  Users,
  Settings,
  ShieldCheck,
  ChevronRight
} from 'lucide-react';
import { useCurrentOrg } from '../../context/OrgContext';

export interface SidebarProps {
  isOpen: boolean;
  onClose?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ isOpen, onClose }) => {
  const { activeOrg, role } = useCurrentOrg();

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 px-3 py-2 rounded-md text-xs font-medium transition-colors ${
      isActive
        ? 'bg-[#1C3B61] text-white shadow-xs'
        : 'text-slate-300 hover:text-white hover:bg-[#1C3B61]/60'
    }`;

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/60 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed top-0 bottom-0 left-0 z-40 w-64 bg-[#142B4A] text-slate-100 flex flex-col border-r border-[#1C3B61] transition-transform duration-200 ease-in-out lg:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Brand Header */}
        <div className="h-16 flex items-center justify-between px-5 border-b border-[#1C3B61]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#0F8B72] flex items-center justify-center text-white font-bold text-sm shadow-xs">
              GF
            </div>
            <div>
              <div className="text-sm font-bold tracking-tight text-white flex items-center gap-1.5">
                GSTFlow
                <span className="text-[10px] bg-[#0F8B72]/30 text-[#0F8B72] px-1.5 py-0.2 rounded font-mono">
                  v1.0
                </span>
              </div>
              <div className="text-[10px] text-slate-400">Reconciliation SaaS</div>
            </div>
          </div>
        </div>

        {/* Current Active Tenant Card */}
        <div className="px-4 py-3 border-b border-[#1C3B61]/80">
          <div className="p-2.5 rounded-md bg-[#1C3B61]/40 border border-[#1C3B61]">
            <div className="text-[10px] uppercase font-semibold tracking-wider text-slate-400 mb-1">
              Active Organization
            </div>
            <div className="text-xs font-semibold text-white truncate">
              {activeOrg?.name || 'No Organization'}
            </div>
            <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-[#1C3B61]/60 text-[10px] text-slate-400">
              <span className="font-mono">Role: {role || 'MEMBER'}</span>
              <span className="flex items-center gap-1 text-[#0F8B72]">
                <ShieldCheck className="w-3 h-3" /> Tenant RLS
              </span>
            </div>
          </div>
        </div>

        {/* Navigation Sections */}
        <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
          {/* Workspace */}
          <div>
            <div className="px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
              Workspace
            </div>
            <nav className="space-y-1">
              <NavLink to="/dashboard" className={navLinkClass} onClick={onClose}>
                <LayoutDashboard className="w-4 h-4 text-slate-300" />
                <span>Dashboard</span>
              </NavLink>

              <NavLink to="/imports" end className={navLinkClass} onClick={onClose}>
                <FileSpreadsheet className="w-4 h-4 text-slate-300" />
                <span>Import History</span>
              </NavLink>

              <NavLink to="/imports/new" className={navLinkClass} onClick={onClose}>
                <UploadCloud className="w-4 h-4 text-[#0F8B72]" />
                <span className="flex-1">Upload Report</span>
                <span className="text-[10px] bg-[#0F8B72]/30 text-emerald-300 px-1.5 py-0.2 rounded">
                  MTR
                </span>
              </NavLink>

              <NavLink to="/reconciliation" end className={navLinkClass} onClick={onClose}>
                <Scale className="w-4 h-4 text-slate-300" />
                <span>Reconciliation</span>
              </NavLink>

              <NavLink to="/reconciliation/discrepancies" className={navLinkClass} onClick={onClose}>
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                <span>Discrepancies</span>
              </NavLink>
            </nav>
          </div>

          {/* Organization */}
          <div>
            <div className="px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
              Organization
            </div>
            <nav className="space-y-1">
              <NavLink to="/gst-registrations" className={navLinkClass} onClick={onClose}>
                <Building2 className="w-4 h-4 text-slate-300" />
                <span>GST Registrations</span>
              </NavLink>

              <NavLink to="/settings/members" className={navLinkClass} onClick={onClose}>
                <Users className="w-4 h-4 text-slate-300" />
                <span>Team Members</span>
              </NavLink>
            </nav>
          </div>

          {/* Account */}
          <div>
            <div className="px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
              Account
            </div>
            <nav className="space-y-1">
              <NavLink to="/settings" end className={navLinkClass} onClick={onClose}>
                <Settings className="w-4 h-4 text-slate-300" />
                <span>Organization Settings</span>
              </NavLink>
            </nav>
          </div>
        </div>

        {/* Footer info */}
        <div className="p-3 border-t border-[#1C3B61] text-[11px] text-slate-400 flex items-center justify-between">
          <div className="truncate">
            <span className="font-mono text-slate-300">GSTFlow Cloud</span>
          </div>
          <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
        </div>
      </aside>
    </>
  );
};
