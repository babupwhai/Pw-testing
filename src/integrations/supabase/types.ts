export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      batches: {
        Row: {
          chat_id: number
          created_at: string
          done: number
          failed: number
          id: string
          source_name: string | null
          telegram_id: number
          total: number
          updated_at: string
        }
        Insert: {
          chat_id: number
          created_at?: string
          done?: number
          failed?: number
          id?: string
          source_name?: string | null
          telegram_id: number
          total?: number
          updated_at?: string
        }
        Update: {
          chat_id?: number
          created_at?: string
          done?: number
          failed?: number
          id?: string
          source_name?: string | null
          telegram_id?: number
          total?: number
          updated_at?: string
        }
        Relationships: []
      }
      bot_users: {
        Row: {
          blocked: boolean
          created_at: string
          daily_limit: number | null
          first_name: string | null
          first_seen_at: string
          id: string
          is_bot_admin: boolean
          last_seen_at: string
          telegram_id: number
          total_jobs: number
          updated_at: string
          username: string | null
        }
        Insert: {
          blocked?: boolean
          created_at?: string
          daily_limit?: number | null
          first_name?: string | null
          first_seen_at?: string
          id?: string
          is_bot_admin?: boolean
          last_seen_at?: string
          telegram_id: number
          total_jobs?: number
          updated_at?: string
          username?: string | null
        }
        Update: {
          blocked?: boolean
          created_at?: string
          daily_limit?: number | null
          first_name?: string | null
          first_seen_at?: string
          id?: string
          is_bot_admin?: boolean
          last_seen_at?: string
          telegram_id?: number
          total_jobs?: number
          updated_at?: string
          username?: string | null
        }
        Relationships: []
      }
      jobs: {
        Row: {
          attempts: number
          batch_id: string | null
          chat_id: number
          created_at: string
          error: string | null
          file_name: string | null
          file_size: number | null
          finished_at: string | null
          id: string
          kind: string
          method: string | null
          ms_taken: number | null
          part_index: number
          parts_sent: number
          position: number
          progress: number
          segment_cursor: number
          selected_quality: string | null
          started_at: string | null
          status: string
          status_message_id: number | null
          stream_url: string | null
          telegram_id: number
          title: string | null
          updated_at: string
          url: string
          variants: Json | null
        }
        Insert: {
          attempts?: number
          batch_id?: string | null
          chat_id: number
          created_at?: string
          error?: string | null
          file_name?: string | null
          file_size?: number | null
          finished_at?: string | null
          id?: string
          kind?: string
          method?: string | null
          ms_taken?: number | null
          part_index?: number
          parts_sent?: number
          position?: number
          progress?: number
          segment_cursor?: number
          selected_quality?: string | null
          started_at?: string | null
          status?: string
          status_message_id?: number | null
          stream_url?: string | null
          telegram_id: number
          title?: string | null
          updated_at?: string
          url: string
          variants?: Json | null
        }
        Update: {
          attempts?: number
          batch_id?: string | null
          chat_id?: number
          created_at?: string
          error?: string | null
          file_name?: string | null
          file_size?: number | null
          finished_at?: string | null
          id?: string
          kind?: string
          method?: string | null
          ms_taken?: number | null
          part_index?: number
          parts_sent?: number
          position?: number
          progress?: number
          segment_cursor?: number
          selected_quality?: string | null
          started_at?: string | null
          status?: string
          status_message_id?: number | null
          stream_url?: string | null
          telegram_id?: number
          title?: string | null
          updated_at?: string
          url?: string
          variants?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "jobs_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
        ]
      }
      pw_nav: {
        Row: {
          created_at: string
          data: Json
          token: string
        }
        Insert: {
          created_at?: string
          data: Json
          token: string
        }
        Update: {
          created_at?: string
          data?: Json
          token?: string
        }
        Relationships: []
      }
      settings: {
        Row: {
          allow_all_users: boolean
          bot_token: string | null
          bot_username: string | null
          default_daily_limit: number
          id: number
          max_file_mb: number
          max_part_mb: number
          parallel_jobs: number
          updated_at: string
          webhook_set_at: string | null
          webhook_url: string | null
          welcome_text: string | null
        }
        Insert: {
          allow_all_users?: boolean
          bot_token?: string | null
          bot_username?: string | null
          default_daily_limit?: number
          id?: number
          max_file_mb?: number
          max_part_mb?: number
          parallel_jobs?: number
          updated_at?: string
          webhook_set_at?: string | null
          webhook_url?: string | null
          welcome_text?: string | null
        }
        Update: {
          allow_all_users?: boolean
          bot_token?: string | null
          bot_username?: string | null
          default_daily_limit?: number
          id?: number
          max_file_mb?: number
          max_part_mb?: number
          parallel_jobs?: number
          updated_at?: string
          webhook_set_at?: string | null
          webhook_url?: string | null
          welcome_text?: string | null
        }
        Relationships: []
      }
      tg_updates: {
        Row: {
          created_at: string
          update_id: number
        }
        Insert: {
          created_at?: string
          update_id: number
        }
        Update: {
          created_at?: string
          update_id?: number
        }
        Relationships: []
      }
      usage_daily: {
        Row: {
          count: number
          day: string
          id: string
          telegram_id: number
        }
        Insert: {
          count?: number
          day?: string
          id?: string
          telegram_id: number
        }
        Update: {
          count?: number
          day?: string
          id?: string
          telegram_id?: number
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin"],
    },
  },
} as const
