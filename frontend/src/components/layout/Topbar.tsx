import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Menu,
  Building,
  Check,
  Plus,
  LogOut,
  ChevronDown,
  Users
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useCurrentOrg } from '../../context/OrgContext';

export interface TopbarProps {
  onMenuClick: () => void;
}

export const Topbar: React.FC<TopbarProps> = ({ onMenuClick }) => {
  const { user, logout } = useAuth();
  const { organizations, activeOrg, setActiveOrgId } = useCurrentOrg();
  const navigate = useNavigate();

  const [isOrgDropdownOpen, setIsOrgDropdownOpen] = useState(false);
  const [isUserDropdownOpen, setIsUserDropdownOpen] = useState(false);

  const orgDropdownRef = useRef<HTMLDivElement>(null);
  const userDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (orgDropdownRef.current && !orgDropdownRef.current.contains(e.target as Node)) {
        setIsOrgDropdownOpen(false);
      }
      if (userDropdownRef.current && !userDropdownRef.current.contains(e.target as Node)) {
        setIsUserDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <header className="h-16 bg-white border-b border-slate-200 sticky top-0 z-30 flex items-center justify-between px-4 sm:px-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onMenuClick}
          className="lg:hidden p-2 rounded-md text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors"
          aria-label="Toggle navigation menu"
        >
          <Menu className="w-5 h-5" />
        </button>

        {/* Organization Switcher Dropdown */}
        <div className="relative" ref={orgDropdownRef}>
          <button
            type="button"
            onClick={() => setIsOrgDropdownOpen((prev) => !prev)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200 hover:border-slate-300 hover:bg-slate-50 transition-colors text-left"
          >
            <div className="w-6 h-6 rounded bg-[#EAF0F7] text-[#142B4A] flex items-center justify-center font-bold text-xs shrink-0">
              <Building className="w-3.5 h-3.5" />
            </div>
            <div className="hidden sm:block">
              <div className="text-xs font-semibold text-slate-900 max-w-[160px] truncate leading-tight">
                {activeOrg?.name || 'Select Organization'}
              </div>
              <div className="text-[10px] text-slate-500 leading-tight">
                {activeOrg ? `Role: ${activeOrg.role}` : 'No organization'}
              </div>
            </div>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0 ml-1" />
          </button>

          {isOrgDropdownOpen && (
            <div className="absolute left-0 mt-1 w-64 rounded-lg bg-white border border-slate-200 shadow-lg py-1.5 z-50 animate-in fade-in zoom-in-95 duration-100">
              <div className="px-3 py-1.5 text-[10px] font-semibold uppercase text-slate-400 tracking-wider">
                Switch Organization
              </div>
              <div className="max-h-56 overflow-y-auto">
                {organizations.map((org) => (
                  <button
                    key={org.id}
                    type="button"
                    onClick={() => {
                      setActiveOrgId(org.id);
                      setIsOrgDropdownOpen(false);
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 text-xs text-slate-800 hover:bg-slate-50 transition-colors text-left"
                  >
                    <div className="truncate pr-2">
                      <div className="font-medium truncate">{org.name}</div>
                      <div className="text-[10px] text-slate-500 font-mono">Role: {org.role}</div>
                    </div>
                    {org.id === activeOrg?.id && (
                      <Check className="w-4 h-4 text-[#0F8B72] shrink-0" />
                    )}
                  </button>
                ))}
              </div>
              <div className="border-t border-slate-100 mt-1 pt-1 px-1 space-y-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setIsOrgDropdownOpen(false);
                    navigate('/onboarding');
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-[#0F8B72] font-medium hover:bg-emerald-50 rounded transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Create new organization</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsOrgDropdownOpen(false);
                    navigate('/join');
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-slate-700 font-medium hover:bg-slate-50 rounded transition-colors"
                >
                  <Users className="w-3.5 h-3.5 text-slate-400" />
                  <span>Join with invitation token</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right User Menu */}
      <div className="flex items-center gap-3">
        <div className="relative" ref={userDropdownRef}>
          <button
            type="button"
            onClick={() => setIsUserDropdownOpen((prev) => !prev)}
            className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-slate-100 transition-colors text-left"
          >
            <div className="w-8 h-8 rounded-full bg-[#142B4A] text-white flex items-center justify-center font-medium text-xs">
              {user?.email?.charAt(0).toUpperCase() || 'U'}
            </div>
            <div className="hidden md:block">
              <div className="text-xs font-medium text-slate-800 max-w-[140px] truncate">
                {user?.email}
              </div>
            </div>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          </button>

          {isUserDropdownOpen && (
            <div className="absolute right-0 mt-1 w-52 rounded-lg bg-white border border-slate-200 shadow-lg py-1.5 z-50 animate-in fade-in zoom-in-95 duration-100">
              <div className="px-3 py-2 border-b border-slate-100 text-xs">
                <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">
                  Signed in as
                </div>
                <div className="font-medium text-slate-800 truncate mt-0.5">{user?.email}</div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsUserDropdownOpen(false);
                  navigate('/settings');
                }}
                className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 transition-colors"
              >
                Account Settings
              </button>
              <div className="border-t border-slate-100 my-1" />
              <button
                type="button"
                onClick={handleLogout}
                className="w-full text-left px-3 py-2 text-xs text-red-600 hover:bg-red-50 flex items-center gap-2 transition-colors font-medium"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Sign out</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
