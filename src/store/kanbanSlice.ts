import type { StateCreator } from "zustand";
import type { TaskCard } from "../types";

export interface KanbanSlice {
  tasks: TaskCard[];
  addTask: (title: string, description?: string) => void;
  updateTask: (id: string, updates: Partial<TaskCard>) => void;
  removeTask: (id: string) => void;
  moveTask: (id: string, status: TaskCard["status"]) => void;
  reorderTask: (id: string, newOrder: number) => void;
}

export const createKanbanSlice: StateCreator<KanbanSlice, [], [], KanbanSlice> = (
  set
) => ({
  tasks: [],

  addTask: (title, description = "") => {
    set((state) => {
      const maxOrder = state.tasks
        .filter((t) => t.status === "todo")
        .reduce((max, t) => Math.max(max, t.order), -1);
      const task: TaskCard = {
        id: `task-${Date.now()}`,
        title,
        description,
        status: "todo",
        createdAt: Date.now(),
        order: maxOrder + 1,
      };
      return { tasks: [...state.tasks, task] };
    });
  },

  updateTask: (id, updates) => {
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    }));
  },

  removeTask: (id) => {
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== id),
    }));
  },

  moveTask: (id, status) => {
    set((state) => {
      const maxOrder = state.tasks
        .filter((t) => t.status === status)
        .reduce((max, t) => Math.max(max, t.order), -1);
      return {
        tasks: state.tasks.map((t) =>
          t.id === id ? { ...t, status, order: maxOrder + 1 } : t
        ),
      };
    });
  },

  reorderTask: (id, newOrder) => {
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id ? { ...t, order: newOrder } : t
      ),
    }));
  },
});
