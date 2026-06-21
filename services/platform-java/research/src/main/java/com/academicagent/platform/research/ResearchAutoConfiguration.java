package com.academicagent.platform.research;

import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;

@Configuration
@ComponentScan(basePackages = "com.academicagent.platform.research")
@EntityScan(basePackages = "com.academicagent.platform.research.entity")
@EnableJpaRepositories(basePackages = "com.academicagent.platform.research.repository")
public class ResearchAutoConfiguration {
}
