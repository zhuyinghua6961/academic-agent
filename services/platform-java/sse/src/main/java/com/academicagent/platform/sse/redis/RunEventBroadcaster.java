package com.academicagent.platform.sse.redis;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

@Component
public class RunEventBroadcaster {

    public static final String CHANNEL_PREFIX = "run:events:";

    private final StringRedisTemplate redisTemplate;

    public RunEventBroadcaster(StringRedisTemplate redisTemplate) {
        this.redisTemplate = redisTemplate;
    }

    public void publish(String runId, String payloadJson) {
        redisTemplate.convertAndSend(channel(runId), payloadJson);
    }

    public static String channel(String runId) {
        return CHANNEL_PREFIX + runId;
    }
}
