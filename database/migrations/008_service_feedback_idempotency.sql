-- A Hunter may retry delivery of the same mission feedback after an HTTP
-- response is lost. Count that logical review once so replica/retry behavior
-- cannot bias service ranking.

CREATE UNIQUE INDEX service_feedback_logical_review_idx
  ON service_feedback (service_id, agent_id, mission_id);
