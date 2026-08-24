import { create } from 'zustand';
import type { Skill } from '@/lib/types';
import * as tauri from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';

interface SkillState {
  skills: Skill[];
  loading: boolean;
  error: string | null;

  fetchSkills: () => Promise<void>;
  addSkill: (name: string, description: string, prompt: string) => Promise<void>;
  updateSkill: (id: string, name?: string, description?: string, prompt?: string) => Promise<void>;
  toggleSkill: (id: string) => Promise<void>;
  deleteSkill: (id: string) => Promise<void>;
  reorderSkills: (orderedIds: string[]) => Promise<void>;
}

export const useSkillStore = create<SkillState>((set, get) => ({
  skills: [],
  loading: false,
  error: null,

  fetchSkills: async () => {
    set({ loading: true, error: null });
    try {
      const skills = await tauri.skillList();
      set({ skills });
    } catch (err) {
      set({ error: getErrorMessage(err) });
    } finally {
      set({ loading: false });
    }
  },

  addSkill: async (name, description, prompt) => {
    set({ loading: true, error: null });
    try {
      await tauri.skillAdd(name, description, prompt);
      await get().fetchSkills();
    } catch (err) {
      set({ error: getErrorMessage(err), loading: false });
    }
  },

  updateSkill: async (id, name, description, prompt) => {
    set({ loading: true, error: null });
    try {
      await tauri.skillUpdate(id, name, description, prompt);
      await get().fetchSkills();
    } catch (err) {
      set({ error: getErrorMessage(err), loading: false });
    }
  },

  toggleSkill: async (id) => {
    // Optimistic update
    set((state) => ({
      skills: state.skills.map((s) =>
        s.id === id ? { ...s, enabled: !s.enabled } : s
      ),
    }));
    try {
      await tauri.skillToggle(id);
    } catch (err) {
      // Revert on failure
      set((state) => ({
        skills: state.skills.map((s) =>
          s.id === id ? { ...s, enabled: !s.enabled } : s
        ),
        error: getErrorMessage(err),
      }));
    }
  },

  deleteSkill: async (id) => {
    set({ loading: true, error: null });
    try {
      await tauri.skillDelete(id);
      await get().fetchSkills();
    } catch (err) {
      set({ error: getErrorMessage(err), loading: false });
    }
  },

  reorderSkills: async (orderedIds) => {
    // 乐观更新：与后端 apply_user_order 相同的 position 分配规则
    const prevSkills = get().skills;
    const posById = new Map(orderedIds.map((id, i) => [id, (i + 1) * 1000]));
    set((state) => ({
      skills: state.skills.map((s) =>
        posById.has(s.id) ? { ...s, position: posById.get(s.id)! } : s,
      ),
    }));
    try {
      await tauri.skillReorder(orderedIds);
    } catch (err) {
      set({ skills: prevSkills, error: getErrorMessage(err) });
    }
  },
}));
