# Send AI symptom check-ins on blood pressure readings to Twilio SMS with OpenAI and AnyBio Govern

![Workflow](workflow.png)

**Self-hosted n8n only.** This template uses the AnyBio Govern community node (`n8n-nodes-anybio`).

## Who's it for

Care teams and digital health builders who want an AI to draft patient check-ins, with a policy check before any message reaches a patient.

## How it works

A blood pressure reading arrives by webhook. An OpenAI model drafts a check-in, and AnyBio Govern evaluates it against your policy:

- **Deliver**: the draft is allowed and Twilio sends it.
- **Show Hold Text**: the draft is held; Twilio sends your fixed holding line instead.
- **Send Nothing**: nothing may be sent (an opt-out, missing consent, the message cap, or AnyBio unreachable).

Every branch records the outcome.

## How to set up

1. Install `n8n-nodes-anybio` from **Settings > Community nodes**.
2. Create credentials for **AnyBio Govern API**, **OpenAI** and **Twilio**.
3. Fill in the **Your settings** node.
4. Click **Execute workflow** to run the sample reading.

## Requirements

- Self-hosted n8n with community nodes enabled
- An AnyBio Govern application key
- An OpenAI API key and a Twilio number

## How to customize the workflow

- Edit **Your settings**: holding line, disclosure text, channel, sender number, model. Your clinical team writes the holding line.
- Change the prompt in **Draft Follow-up**.
- Never connect patient messaging to **Send Nothing**.

The sample uses synthetic data and fictional numbers.
