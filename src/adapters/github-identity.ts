import { z } from "zod";

const githubOwnerSchema = z.string().regex(/^[A-Za-z0-9-]+$/u);
const githubRepositoryNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+$/u)
  .refine((value) => value !== "." && value !== "..");

export const githubIdentitySchema = z.object({
  owner: githubOwnerSchema,
  name: githubRepositoryNameSchema,
});
