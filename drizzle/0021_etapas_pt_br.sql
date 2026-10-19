-- Renomeia as etapas semeadas em espanhol para pt-BR. Só troca o nome exato
-- do seed antigo: etapas renomeadas pelo proprietário não são tocadas.
UPDATE "pipeline_stage" SET "name" = 'Novo' WHERE "name" = 'Nuevo';--> statement-breakpoint
UPDATE "pipeline_stage" SET "name" = 'Em conversa' WHERE "name" = 'En conversación';--> statement-breakpoint
UPDATE "pipeline_stage" SET "name" = 'Interessado' WHERE "name" = 'Interesado';--> statement-breakpoint
UPDATE "lead_stage_event" SET "from_stage_name" = 'Novo' WHERE "from_stage_name" = 'Nuevo';--> statement-breakpoint
UPDATE "lead_stage_event" SET "from_stage_name" = 'Em conversa' WHERE "from_stage_name" = 'En conversación';--> statement-breakpoint
UPDATE "lead_stage_event" SET "from_stage_name" = 'Interessado' WHERE "from_stage_name" = 'Interesado';--> statement-breakpoint
UPDATE "lead_stage_event" SET "to_stage_name" = 'Novo' WHERE "to_stage_name" = 'Nuevo';--> statement-breakpoint
UPDATE "lead_stage_event" SET "to_stage_name" = 'Em conversa' WHERE "to_stage_name" = 'En conversación';--> statement-breakpoint
UPDATE "lead_stage_event" SET "to_stage_name" = 'Interessado' WHERE "to_stage_name" = 'Interesado';
