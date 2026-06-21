package com.academicagent.platform.sse.kafka;

import java.util.HashMap;
import java.util.Map;

import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.ConcurrentKafkaListenerContainerFactory;
import org.springframework.kafka.core.ConsumerFactory;
import org.springframework.kafka.core.DefaultKafkaConsumerFactory;
import org.springframework.kafka.support.serializer.JsonDeserializer;

@Configuration
public class KafkaConsumerConfig {

    @Value("${spring.kafka.bootstrap-servers}")
    private String bootstrapServers;

    @Bean
    public ConsumerFactory<String, RunEventEnvelope> runEventConsumerFactory() {
        Map<String, Object> config = consumerConfig();
        JsonDeserializer<RunEventEnvelope> deserializer = new JsonDeserializer<>(RunEventEnvelope.class, false);
        deserializer.addTrustedPackages("*");
        return new DefaultKafkaConsumerFactory<>(config, new StringDeserializer(), deserializer);
    }

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, RunEventEnvelope> runEventKafkaListenerContainerFactory() {
        ConcurrentKafkaListenerContainerFactory<String, RunEventEnvelope> factory =
                new ConcurrentKafkaListenerContainerFactory<>();
        factory.setConsumerFactory(runEventConsumerFactory());
        return factory;
    }

    @Bean
    public ConsumerFactory<String, RunCompletedEvent> runCompletedConsumerFactory() {
        Map<String, Object> config = consumerConfig();
        JsonDeserializer<RunCompletedEvent> deserializer = new JsonDeserializer<>(RunCompletedEvent.class, false);
        deserializer.addTrustedPackages("*");
        return new DefaultKafkaConsumerFactory<>(config, new StringDeserializer(), deserializer);
    }

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, RunCompletedEvent>
            runCompletedKafkaListenerContainerFactory() {
        ConcurrentKafkaListenerContainerFactory<String, RunCompletedEvent> factory =
                new ConcurrentKafkaListenerContainerFactory<>();
        factory.setConsumerFactory(runCompletedConsumerFactory());
        return factory;
    }

    private Map<String, Object> consumerConfig() {
        Map<String, Object> config = new HashMap<>();
        config.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        config.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        config.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        return config;
    }
}
