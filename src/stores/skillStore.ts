import { create } from 'zustand';
import type { Skill } from '@/lib/types';
import * as tauri from '@/lib/tauri';
import { withLoading } from './createCrudStore';

interface SkillState {
  skills: Skill[];
  loading: boolean;
  error: string | null;

  fetchSkills: () => Promise<void>;
  addSkill: (name: string, description: string, prompt: string) => Promise<void>;
  updateSkill: (id: string, name?: string, description?: string, prompt?: string) => Promise<void>;
  toggleSkill: (id: string) => Promise<void>;
  deleteSkill: (id: string) => Promise<void>;
}

export const useSkillStore = create<SkillState>((set, get) => ({
  skills: [],
  loading: false,
  error: null,

  fetchSkills: () => withLoading(set, async () => {
    const skills = await tauri.skillList();
    set({ skills });
  }),

  addSkill: (name, description, prompt) => withLoading(set, async () => {
    await tauri.skillAdd(name, description, prompt);
    await get().fetchSkills();
  }),

  updateSkill: (id, name, description, prompt) => withLoading(set, async () => {
    await tauri.skillUpdate(id, name, description, prompt);
    await get().fetchSkills();
  }),

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
        error: String(err),
      }));
    }
  },

  deleteSkill: (id) => withLoading(set, async () => {
    await tauri.skillDelete(id);
    await get().fetchSkills();
  }),
}));
