import { create } from 'zustand';
import type { Skill } from '@/lib/types';
import * as tauri from '@/lib/tauri';

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

  fetchSkills: async () => {
    set({ loading: true, error: null });
    try {
      const skills = await tauri.skillList();
      set({ skills, loading: false });
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },

  addSkill: async (name, description, prompt) => {
    set({ loading: true, error: null });
    try {
      await tauri.skillAdd(name, description, prompt);
      await get().fetchSkills();
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },

  updateSkill: async (id, name, description, prompt) => {
    set({ loading: true, error: null });
    try {
      await tauri.skillUpdate(id, name, description, prompt);
      await get().fetchSkills();
    } catch (err) {
      set({ error: String(err), loading: false });
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
        error: String(err),
      }));
    }
  },

  deleteSkill: async (id) => {
    set({ loading: true, error: null });
    try {
      await tauri.skillDelete(id);
      await get().fetchSkills();
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },
}));
