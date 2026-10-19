CREATE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit.conversation_turns FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
