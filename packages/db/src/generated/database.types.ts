export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: {
          extensions?: Json;
          operationName?: string;
          query?: string;
          variables?: Json;
        };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      ai_message: {
        Row: {
          author_id: string | null;
          created_at: string;
          id: string;
          metadata: Json | null;
          parts: Json;
          role: string;
          run_id: string | null;
          seq: number;
          thread_id: string;
        };
        Insert: {
          author_id?: string | null;
          created_at?: string;
          id: string;
          metadata?: Json | null;
          parts: Json;
          role: string;
          run_id?: string | null;
          seq?: number;
          thread_id: string;
        };
        Update: {
          author_id?: string | null;
          created_at?: string;
          id?: string;
          metadata?: Json | null;
          parts?: Json;
          role?: string;
          run_id?: string | null;
          seq?: number;
          thread_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ai_message_author_id_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "user_profile";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_message_thread_id_fkey";
            columns: ["thread_id"];
            isOneToOne: false;
            referencedRelation: "ai_thread";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_thread: {
        Row: {
          created_at: string;
          creation_id: string | null;
          current_run_id: string | null;
          id: string;
          retired_at: string | null;
          room_id: string;
          run_by: string | null;
          run_started_at: string | null;
          run_status: string;
          title: string;
          title_source: string;
        };
        Insert: {
          created_at?: string;
          creation_id?: string | null;
          current_run_id?: string | null;
          id?: string;
          retired_at?: string | null;
          room_id: string;
          run_by?: string | null;
          run_started_at?: string | null;
          run_status?: string;
          title?: string;
          title_source?: string;
        };
        Update: {
          created_at?: string;
          creation_id?: string | null;
          current_run_id?: string | null;
          id?: string;
          retired_at?: string | null;
          room_id?: string;
          run_by?: string | null;
          run_started_at?: string | null;
          run_status?: string;
          title?: string;
          title_source?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ai_thread_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "room";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_thread_run_by_fkey";
            columns: ["run_by"];
            isOneToOne: false;
            referencedRelation: "user_profile";
            referencedColumns: ["id"];
          },
        ];
      };
      desktop_prompt_suggestion: {
        Row: {
          author_id: string;
          created_at: string;
          id: string;
          prompt: string;
          revision: number;
          room_id: string;
          source_message_ids: string[];
          sources: Json;
          updated_at: string;
        };
        Insert: {
          author_id: string;
          created_at?: string;
          id?: string;
          prompt: string;
          revision?: number;
          room_id: string;
          source_message_ids: string[];
          sources: Json;
          updated_at?: string;
        };
        Update: {
          author_id?: string;
          created_at?: string;
          id?: string;
          prompt?: string;
          revision?: number;
          room_id?: string;
          source_message_ids?: string[];
          sources?: Json;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "desktop_prompt_suggestion_author_id_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "user_profile";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "desktop_prompt_suggestion_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "room";
            referencedColumns: ["id"];
          },
        ];
      };
      message: {
        Row: {
          author_id: string;
          created_at: string;
          id: string;
          room_id: string;
          text: string;
        };
        Insert: {
          author_id: string;
          created_at?: string;
          id?: string;
          room_id: string;
          text: string;
        };
        Update: {
          author_id?: string;
          created_at?: string;
          id?: string;
          room_id?: string;
          text?: string;
        };
        Relationships: [
          {
            foreignKeyName: "message_author_id_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "user_profile";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "message_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "room";
            referencedColumns: ["id"];
          },
        ];
      };
      room: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          slug: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          slug: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          slug?: string;
        };
        Relationships: [];
      };
      room_invite: {
        Row: {
          accepted_at: string | null;
          accepted_by: string | null;
          created_at: string;
          created_by: string;
          expires_at: string;
          id: string;
          invited_email: string | null;
          revoked_at: string | null;
          room_id: string;
          token_hash: string;
        };
        Insert: {
          accepted_at?: string | null;
          accepted_by?: string | null;
          created_at?: string;
          created_by: string;
          expires_at: string;
          id?: string;
          invited_email?: string | null;
          revoked_at?: string | null;
          room_id: string;
          token_hash: string;
        };
        Update: {
          accepted_at?: string | null;
          accepted_by?: string | null;
          created_at?: string;
          created_by?: string;
          expires_at?: string;
          id?: string;
          invited_email?: string | null;
          revoked_at?: string | null;
          room_id?: string;
          token_hash?: string;
        };
        Relationships: [
          {
            foreignKeyName: "room_invite_accepted_by_fkey";
            columns: ["accepted_by"];
            isOneToOne: false;
            referencedRelation: "user_profile";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "room_invite_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "user_profile";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "room_invite_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "room";
            referencedColumns: ["id"];
          },
        ];
      };
      room_member: {
        Row: {
          created_at: string;
          is_admin: boolean;
          last_visited_at: string;
          member_id: string;
          room_id: string;
        };
        Insert: {
          created_at?: string;
          is_admin: boolean;
          last_visited_at?: string;
          member_id: string;
          room_id: string;
        };
        Update: {
          created_at?: string;
          is_admin?: boolean;
          last_visited_at?: string;
          member_id?: string;
          room_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "room_member_member_id_fkey";
            columns: ["member_id"];
            isOneToOne: false;
            referencedRelation: "user_profile";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "room_member_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "room";
            referencedColumns: ["id"];
          },
        ];
      };
      user_profile: {
        Row: {
          created_at: string;
          id: string;
          image_url: string | null;
          name: string;
        };
        Insert: {
          created_at?: string;
          id: string;
          image_url?: string | null;
          name: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          image_url?: string | null;
          name?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      _ai_assert_member: {
        Args: { p_actor_id: string; p_room_id: string };
        Returns: undefined;
      };
      accept_room_invite: {
        Args: { p_token_hash: string; p_user_id: string };
        Returns: {
          accepted_room_id: string;
          accepted_room_slug: string;
          status: string;
        }[];
      };
      archive_ai_thread: {
        Args: { p_actor_id: string; p_room_id: string; p_thread_id: string };
        Returns: {
          outcome: string;
          retired_at: string;
          thread_id: string;
        }[];
      };
      claim_ai_thread_run: {
        Args: {
          p_actor_id: string;
          p_metadata?: Json;
          p_parts: Json;
          p_room_id: string;
          p_run_id: string;
          p_thread_id: string;
          p_user_message_id: string;
        };
        Returns: {
          accepted_message_seq: number;
          outcome: string;
          run_by: string;
          run_id: string;
          run_status: string;
          thread_id: string;
          title: string;
          title_source: string;
        }[];
      };
      create_ai_thread: {
        Args: { p_actor_id: string; p_creation_id?: string; p_room_id: string };
        Returns: {
          created_at: string;
          current_run_id: string;
          retired_at: string;
          room_id: string;
          run_status: string;
          thread_id: string;
          title: string;
          title_source: string;
        }[];
      };
      finalize_ai_thread_run: {
        Args: {
          p_actor_id: string;
          p_room_id: string;
          p_run_id: string;
          p_status: string;
          p_thread_id: string;
        };
        Returns: {
          outcome: string;
          run_id: string;
          run_status: string;
          thread_id: string;
        }[];
      };
      rename_ai_thread: {
        Args: {
          p_actor_id: string;
          p_room_id: string;
          p_thread_id: string;
          p_title: string;
        };
        Returns: {
          thread_id: string;
          title: string;
          title_source: string;
        }[];
      };
      restore_ai_thread: {
        Args: { p_actor_id: string; p_room_id: string; p_thread_id: string };
        Returns: {
          outcome: string;
          retired_at: string;
          thread_id: string;
        }[];
      };
      write_ai_thread_message: {
        Args: {
          p_actor_id: string;
          p_author_id?: string;
          p_message_id: string;
          p_metadata?: Json;
          p_parts: Json;
          p_role: string;
          p_room_id: string;
          p_run_id: string;
          p_thread_id: string;
        };
        Returns: {
          message_id: string;
          outcome: string;
          seq: number;
        }[];
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<
  keyof Database,
  "public"
>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const;
