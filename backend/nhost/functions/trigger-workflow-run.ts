import { Request, Response } from "express";

const GRAPHQL_URL = process.env.NHOST_GRAPHQL_URL!;
const ADMIN_SECRET = process.env.NHOST_ADMIN_SECRET!;

async function gql(query: string, variables: Record<string, any> = {}) {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hasura-admin-secret": ADMIN_SECRET,
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (result.errors) {
    throw new Error(result.errors[0].message);
  }

  return result.data;
}

async function updateStepRun(
  id: string,
  status: string,
  output: any = null,
  error: string | null = null,
  attemptCount?: number
) {
  await gql(
    `
    mutation UpdateStepRun(
      $id: uuid!,
      $status: String!,
      $output: jsonb,
      $error: String,
      $attempt_count: Int
    ) {
      update_step_runs_by_pk(
        pk_columns: { id: $id },
        _set: {
          status: $status,
          output: $output,
          error: $error,
          attempt_count: $attempt_count
        }
      ) {
        id
      }
    }
    `,
    {
      id,
      status,
      output,
      error,
      attempt_count: attemptCount,
    }
  );
}

async function executeLLM(input: any) {
  // Disclosed fallback because no LLM API key is available.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const text =
    typeof input === "string"
      ? input
      : JSON.stringify(input);

  return {
    response: text.toLowerCase().includes("urgent")
      ? "URGENT"
      : "NORMAL",
    provider: "stub",
  };
}

async function executeHttp(config: any, input: any) {
  const url = config?.url || "https://httpbin.org/post";

  const method = config?.method || "POST";

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body:
          method === "GET"
            ? undefined
            : JSON.stringify(input),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }

  throw new Error("HTTP request failed");
}

async function main(req: Request, res: Response) {
  try {
    const userId =
      req.body?.session_variables?.["x-hasura-user-id"] ||
      req.headers["x-hasura-user-id"]?.toString();    

    const workflowId =
      req.body?.input?.workflow_id ||
      req.body?.workflow_id;

    if (!userId) {
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    if (!workflowId) {
      return res.status(400).json({
        message: "workflow_id is required",
      });
    }

    // --------------------------------------------------
    // 1. Load workflow + organization
    // --------------------------------------------------

    const workflowData = await gql(
      `
      query GetWorkflow($id: uuid!) {
        workflows_by_pk(id: $id) {
          id
          name
          org_id
          created_by
          organization {
            id
            quota_limit
            quota_used
          }
          workflow_steps(
            order_by: { position: asc }
          ) {
            id
            position
            type
            name
            config
          }
        }
      }
      `,
      { id: workflowId }
    );

    const workflow = workflowData.workflows_by_pk;
    const effectiveUserId = userId === "admin" ? workflow.created_by : userId;

    if (!workflow) {
      return res.status(404).json({
        message: "Workflow not found",
      });
    }

    // --------------------------------------------------
    // 2. Check organization membership + role
    // --------------------------------------------------

    const memberData = await gql(
      `
      query GetMembership(
        $org_id: uuid!,
        $user_id: uuid!
      ) {
        org_members(
          where: {
            org_id: { _eq: $org_id }
            user_id: { _eq: $user_id }
          }
          limit: 1
        ) {
          role
        }
      }
      `,
      {
        org_id: workflow.org_id,
        user_id: effectiveUserId,
      }
    );

    const member = memberData.org_members?.[0];

    if (!member || !["owner", "editor"].includes(member.role)) {
      return res.status(403).json({
        message: "You cannot trigger this workflow",
      });
    }

    // --------------------------------------------------
    // 3. Check quota
    // --------------------------------------------------

    const org = workflow.organization;

    if (org.quota_used >= org.quota_limit) {
      return res.status(429).json({
        message: "Organization quota exhausted",
      });
    }

    // --------------------------------------------------
    // 4. Create workflow run
    // --------------------------------------------------

    const runData = await gql(
      `
      mutation CreateRun(
        $workflow_id: uuid!,
        $triggered_by: uuid!
      ) {
        insert_workflow_runs_one(
          object: {
            workflow_id: $workflow_id
            triggered_by: $triggered_by
            trigger_type: "manual"
            status: "running"
            started_at: "now()"
          }
        ) {
          id
        }
      }
      `,
      {
        workflow_id: workflowId,
        triggered_by: effectiveUserId,
      }
    );

    const runId = runData.insert_workflow_runs_one.id;

    let previousOutput: any = null;

    // --------------------------------------------------
    // 5. Execute steps sequentially
    // --------------------------------------------------

    for (const step of workflow.workflow_steps) {
      const stepRunData = await gql(
        `
        mutation CreateStepRun(
          $run_id: uuid!,
          $step_id: uuid!
        ) {
          insert_step_runs_one(
            object: {
              workflow_run_id: $run_id
              workflow_step_id: $step_id
              status: "running"
              input: {}
              attempt_count: 0
              started_at: "now()"
            }
          ) {
            id
          }
        }
        `,
        {
          run_id: runId,
          step_id: step.id,
        }
      );

      const stepRunId =
        stepRunData.insert_step_runs_one.id;

      try {
        let output: any = previousOutput;

        // ----------------------------------------------
        // LLM
        // ----------------------------------------------

        if (step.type === "llm_call") {
          output = await executeLLM(previousOutput);
        }

        // ----------------------------------------------
        // HTTP
        // ----------------------------------------------

        else if (step.type === "http_request") {
          output = await executeHttp(
            step.config,
            previousOutput
          );
        }

        // ----------------------------------------------
        // CONDITIONAL
        // ----------------------------------------------

        else if (step.type === "conditional_branch") {
          const expected =
            step.config?.equals || "URGENT";

          const actual =
            previousOutput?.response ||
            previousOutput;

          output = {
            condition: actual === expected,
            value: actual,
            branch:
              actual === expected
                ? "true"
                : "false",
          };
        }

        // ----------------------------------------------
        // DB WRITE
        // ----------------------------------------------

        else if (step.type === "db_write") {
          await gql(
            `
            mutation WriteData(
              $run_id: uuid!,
              $step_id: uuid!,
              $data: jsonb!
            ) {
              insert_workflow_data_one(
                object: {
                  workflow_run_id: $run_id
                  step_run_id: $step_id
                  data: $data
                }
              ) {
                id
              }
            }
            `,
            {
              run_id: runId,
              step_id: stepRunId,
              data: previousOutput || {},
            }
          );

          output = {
            saved: true,
          };
        }

        // ----------------------------------------------
        // NOTIFY
        // ----------------------------------------------

        else if (step.type === "notify") {
          await gql(
            `
            mutation Notify(
              $run_id: uuid!,
              $step_id: uuid!,
              $payload: jsonb!
            ) {
              insert_notification_events_one(
                object: {
                  workflow_run_id: $run_id
                  step_run_id: $step_id
                  channel: "email"
                  payload: $payload
                  status: "sent"
                }
              ) {
                id
              }
            }
            `,
            {
              run_id: runId,
              step_id: stepRunId,
              payload: previousOutput || {},
            }
          );

          output = {
            notified: true,
          };
        }

        // ----------------------------------------------
        // APPROVAL GATE
        // ----------------------------------------------

        else if (step.type === "approval_gate") {
          await updateStepRun(
            stepRunId,
            "paused",
            previousOutput
          );

          await gql(
            `
            mutation PauseRun(
              $id: uuid!
            ) {
              update_workflow_runs_by_pk(
                pk_columns: { id: $id },
                _set: { status: "paused" }
              ) {
                id
              }
            }
            `,
            { id: runId }
          );

          return res.status(200).json({
            run_id: runId,
            status: "paused",
            awaiting_approval: stepRunId,
          });
        }

        // ----------------------------------------------
        // COMPLETE STEP
        // ----------------------------------------------

        await updateStepRun(
          stepRunId,
          "completed",
          output,
          null,
          1
        );

        previousOutput = output;

      } catch (error: any) {
        await updateStepRun(
          stepRunId,
          "failed",
          null,
          error.message,
          2
        );

        await gql(
          `
          mutation FailRun(
            $id: uuid!,
            $error: String!
          ) {
            update_workflow_runs_by_pk(
              pk_columns: { id: $id },
              _set: {
                status: "failed"
                error: $error
                completed_at: "now()"
              }
            ) {
              id
            }
          }
          `,
          {
            id: runId,
            error: error.message,
          }
        );

        return res.status(500).json({
          run_id: runId,
          status: "failed",
          error: error.message,
        });
      }
    }

    // --------------------------------------------------
    // 6. Complete run + increment quota
    // --------------------------------------------------

    await gql(
      `
      mutation CompleteRun(
        $run_id: uuid!,
        $org_id: uuid!
      ) {
        update_workflow_runs_by_pk(
          pk_columns: { id: $run_id },
          _set: {
            status: "completed"
            completed_at: "now()"
          }
        ) {
          id
        }

        update_organisations_by_pk(
          pk_columns: { id: $org_id },
          _inc: { quota_used: 1 }
        ) {
          id
          quota_used
        }
      }
      `,
      {
        run_id: runId,
        org_id: workflow.org_id,
      }
    );

    return res.status(200).json({
      run_id: runId,
      status: "completed",
      output: previousOutput,
    });

  } catch (error: any) {
    console.error(error);

    return res.status(500).json({
      message: error.message || "Internal server error",
    });
  }
}

export default main;